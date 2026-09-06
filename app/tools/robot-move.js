import process from "node:process";
import { pathToFileURL } from "node:url";

import { DEFAULT_SOCKET, RobotClient, rpcResult } from "./robot-client.js";

const ALIASES = new Map([
  ["forward", "forward"],
  ["up", "forward"],
  ["backward", "backward"],
  ["back", "backward"],
  ["down", "backward"],
  ["turn-left", "turn-left"],
  ["left", "turn-left"],
  ["turn-right", "turn-right"],
  ["right", "turn-right"],
]);
const DEFAULT_SPEED = Object.freeze({
  forward: 0.2,
  backward: 0.15,
  "turn-left": 0.6,
  "turn-right": 0.6,
});

function boundedNumber(value, name, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new TypeError(`${name} must be from ${min} to ${max}`);
  }
  return number;
}

function canonicalDirection(direction) {
  const canonical = ALIASES.get(direction);
  if (!canonical) {
    throw new TypeError(
      `direction must be one of: forward, backward, turn-left, turn-right`,
    );
  }
  return canonical;
}

export function moveParams(direction, speed) {
  const canonical = canonicalDirection(direction);
  const magnitude = speed === undefined
    ? DEFAULT_SPEED[canonical]
    : boundedNumber(speed, "speed", { min: 0.01, max: 2 });
  if (canonical === "forward") return { vx: magnitude, vy: 0, vyaw: 0 };
  if (canonical === "backward") return { vx: -magnitude, vy: 0, vyaw: 0 };
  if (canonical === "turn-left") return { vx: 0, vy: 0, vyaw: magnitude };
  return { vx: 0, vy: 0, vyaw: -magnitude };
}

export function parseMoveArgs(argv) {
  let direction = null;
  let seconds = 1;
  let speed;
  let rate = 20;
  let socketPath = DEFAULT_SOCKET;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-") && direction === null) {
      direction = arg;
      continue;
    }
    const value = argv[i + 1];
    if (arg === "--seconds" && value !== undefined) {
      seconds = boundedNumber(value, "seconds", { min: 0.05, max: 60 });
    } else if (arg === "--speed" && value !== undefined) {
      speed = boundedNumber(value, "speed", { min: 0.01, max: 2 });
    } else if (arg === "--rate" && value !== undefined) {
      rate = boundedNumber(value, "rate", { min: 5, max: 50 });
    } else if (arg === "--socket" && value) {
      socketPath = value;
    } else {
      throw new TypeError(`unknown or incomplete argument: ${arg}`);
    }
    i++;
  }
  if (direction === null) {
    throw new TypeError(
      "usage: npm run robot:move -- <direction> [--seconds N] [--speed N] [--rate HZ] [--socket PATH]",
    );
  }
  direction = canonicalDirection(direction);
  return { direction, seconds, speed, rate, socketPath };
}

function abortError() {
  const error = new Error("movement interrupted");
  error.name = "AbortError";
  return error;
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(abortError());
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function driveRobot({
  direction,
  seconds = 1,
  speed,
  rate = 20,
  socketPath = DEFAULT_SOCKET,
  client,
  signal,
} = {}) {
  const canonical = canonicalDirection(direction);
  seconds = boundedNumber(seconds, "seconds", { min: 0.05, max: 60 });
  rate = boundedNumber(rate, "rate", { min: 5, max: 50 });
  const params = moveParams(canonical, speed);
  const robot = client ?? new RobotClient({ socketPath });
  const ownsClient = client === undefined;
  let started = false;
  let failure = null;
  let moveResult;
  let stopResult;

  try {
    moveResult = rpcResult(
      await robot.request("robot.move", params),
      "robot.move",
      { accepted: true },
    );
    started = true;
    const intervalMs = 1_000 / rate;
    const deadline = Date.now() + seconds * 1_000;
    while (Date.now() < deadline) {
      await wait(Math.min(intervalMs, deadline - Date.now()), signal);
      if (Date.now() < deadline) await robot.notify("robot.move", params);
    }
  } catch (error) {
    failure = error;
  }

  if (started) {
    try {
      stopResult = rpcResult(
        await robot.request("robot.stop"),
        "robot.stop",
        { accepted: true },
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (ownsClient) robot.close();
  if (failure) throw failure;
  return { direction: canonical, seconds, rate, params, move: moveResult, stop: stopResult };
}

async function main() {
  const options = parseMoveArgs(process.argv.slice(2));
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  try {
    const result = await driveRobot({ ...options, signal: abort.signal });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error.name === "AbortError") process.exitCode = 130;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (process.exitCode === undefined) process.exitCode = 1;
  });
}
