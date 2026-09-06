// Programmatic input source for the physical Microduck JSON-RPC contract.
//
// This module deliberately knows nothing about WebSockets, Unix sockets, or
// the browser UI. It translates protocol intents into the same source shape
// used by keyboard, gamepad, and touch. A transport can therefore be replaced
// without touching the simulator or policy loop.

const JSONRPC_VERSION = "2.0";
const DEFAULT_DEADMAN_MS = 500;
const ZERO_PARAMS = Object.freeze({ vx: 0, vy: 0, vyaw: 0 });
const SKILL_ACTIONS = Object.freeze({
  ground_pick: "groundPick",
  kick_left: "kickL",
  kick_right: "kickR",
  sit_toggle: "sitToggle",
  roulade: "roll",
});

const ERROR = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function rpcError(id, code, message) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function decodeMoveParams(params) {
  if (!isObject(params)) throw new TypeError("params must be an object");
  const known = new Set(["vx", "vy", "vyaw"]);
  const unknown = Object.keys(params).find((key) => !known.has(key));
  if (unknown) throw new TypeError(`unknown field \`${unknown}\``);

  const decoded = { ...ZERO_PARAMS };
  for (const key of known) {
    if (!own(params, key)) continue;
    if (typeof params[key] !== "number" || !Number.isFinite(params[key])) {
      throw new TypeError(`\`${key}\` must be a finite number`);
    }
    decoded[key] = params[key];
  }
  return decoded;
}

function decodeDoParams(params) {
  if (!isObject(params)) throw new TypeError("params must be an object");
  const unknown = Object.keys(params).find((key) => key !== "skill");
  if (unknown) throw new TypeError(`unknown field \`${unknown}\``);
  if (typeof params.skill !== "string" || !own(SKILL_ACTIONS, params.skill)) {
    throw new TypeError(
      `\`skill\` must be one of: ${Object.keys(SKILL_ACTIONS).join(", ")}`,
    );
  }
  return params.skill;
}

function decodeEmptyParams(params) {
  if (params === undefined) return;
  if (!isObject(params) || Object.keys(params).length !== 0) {
    throw new TypeError("params must be omitted or an empty object");
  }
}

export class ApiSource {
  id = "api";
  connected = true;
  command = new Float32Array(3);
  axes = { jaw: 0, orbitX: 0, orbitY: 0 };
  pressed = {};
  onAction = () => {};

  #active = false;
  #lastMoveAt = -Infinity;
  #deadmanMs;
  #now;

  constructor({ deadmanMs = DEFAULT_DEADMAN_MS, now = () => performance.now() } = {}) {
    this.#deadmanMs = deadmanMs;
    this.#now = now;
  }

  init() {}

  dispose() {
    this.#release();
    this.connected = false;
  }

  isActive() {
    return this.#active;
  }

  // The physical robot applies a 500 ms dead-man to velocity, but leaves a
  // stale head pose alone. We mirror the velocity half here. Once released,
  // local keyboard/gamepad control can take authority again.
  poll() {
    if (this.#active && this.#now() - this.#lastMoveAt > this.#deadmanMs) {
      this.#release();
    }
  }

  move({ vx, vy, vyaw }) {
    this.command[0] = vx;
    this.command[1] = vy;
    this.command[2] = vyaw;
    this.#lastMoveAt = this.#now();
    this.#active = true;
  }

  stop() {
    // An explicit stop differs from an all-zero move: it releases API
    // authority immediately so local controls can take over without waiting
    // for the 500 ms dead-man.
    this.#release();
  }

  // Discrete skills use the same Controller action path as keyboard and
  // gamepad input. Unlike those fire-and-forget sources, the API carries the
  // game's synchronous acceptance decision back to the JSON-RPC caller.
  doSkill(skill) {
    const outcome = this.onAction(SKILL_ACTIONS[skill], { skill });
    if (outcome?.accepted === true) return { accepted: true };
    if (outcome?.accepted === false) {
      return typeof outcome.reason === "string" && outcome.reason
        ? { accepted: false, reason: outcome.reason }
        : { accepted: false, reason: `${skill} was refused by the simulator` };
    }
    return {
      accepted: false,
      reason: "simulator controller did not answer the skill request",
    };
  }

  #release() {
    this.command.fill(0);
    this.#active = false;
    this.#lastMoveAt = -Infinity;
  }
}

export class MicroduckRpc {
  #source;
  #getState = () => ({ ready: false });

  constructor({ source, getState } = {}) {
    if (!source) throw new TypeError("source is required");
    this.#source = source;
    if (getState !== undefined) this.setStateProvider(getState);
  }

  setStateProvider(getState) {
    if (typeof getState !== "function") {
      throw new TypeError("state provider must be a function");
    }
    this.#getState = getState;
  }

  // Accept either decoded JSON or a wire-format string. Returning null means
  // the input was a JSON-RPC notification and must not receive a response.
  receive(input) {
    let request = input;
    if (typeof input === "string") {
      try {
        request = JSON.parse(input);
      } catch (error) {
        return rpcError(null, ERROR.parse, error.message);
      }
    }

    if (!isObject(request) || request.jsonrpc !== JSONRPC_VERSION || typeof request.method !== "string") {
      return rpcError(null, ERROR.invalidRequest, "invalid JSON-RPC 2.0 request");
    }

    const notification = !own(request, "id") || request.id === null;
    const id = notification ? null : request.id;
    if (!notification && typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, ERROR.invalidRequest, "id must be a string or number");
    }

    let result;
    try {
      switch (request.method) {
        case "robot.move":
          this.#source.move(decodeMoveParams(request.params));
          result = { accepted: true };
          break;
        case "robot.stop":
          this.#source.stop();
          result = { accepted: true };
          break;
        case "robot.do":
          result = this.#source.doSkill(decodeDoParams(request.params));
          break;
        case "robot.get_state":
          decodeEmptyParams(request.params);
          result = this.#getState();
          if (!isObject(result)) throw new TypeError("state provider must return an object");
          break;
        default:
          if (notification) return null;
          return rpcError(id, ERROR.methodNotFound, `method not found: ${request.method}`);
      }
    } catch (error) {
      if (notification) return null;
      return rpcError(id, ERROR.invalidParams, error.message);
    }

    return notification ? null : rpcResult(id, result);
  }
}
