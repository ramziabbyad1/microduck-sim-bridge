import net from "node:net";

export const DEFAULT_SOCKET = "/tmp/microduck-sim/robotd.sock";

function wireMessage(method, params, id) {
  const message = { jsonrpc: "2.0", method };
  if (id !== undefined) message.id = id;
  if (params !== undefined) message.params = params;
  return `${JSON.stringify(message)}\n`;
}

export function rpcResult(response, method, { accepted = false } = {}) {
  if (response?.error) {
    const code = response.error.code ?? "unknown";
    throw new Error(`${method} failed (${code}): ${response.error.message ?? "unknown error"}`);
  }
  if (response === null || typeof response !== "object" || !("result" in response)) {
    throw new Error(`${method} returned an invalid JSON-RPC response`);
  }
  if (accepted && response.result?.accepted !== true) {
    throw new Error(response.result?.reason ?? `${method} was refused`);
  }
  return response.result;
}

export class RobotClient {
  #socketPath;
  #timeoutMs;
  #socket = null;
  #connected = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();

  constructor({ socketPath = DEFAULT_SOCKET, timeoutMs = 5_000 } = {}) {
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
  }

  connect() {
    if (this.#connected) return this.#connected;

    const socket = net.createConnection(this.#socketPath);
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", (error) => this.#failPending(error));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#connected = null;
      }
      this.#failPending(new Error("robot socket closed before a response arrived"));
    });

    this.#connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return this.#connected;
  }

  async request(method, params, { timeoutMs = this.#timeoutMs } = {}) {
    await this.connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting for ${method} response`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.#socket.write(wireMessage(method, params, id));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async notify(method, params) {
    await this.connect();
    this.#socket.write(wireMessage(method, params));
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#connected = null;
    socket?.destroy();
    this.#failPending(new Error("robot client closed"));
  }

  #receive(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;

      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.#failPending(new Error(`invalid JSON response: ${error.message}`));
        this.#socket?.destroy();
        return;
      }
      const pending = this.#pending.get(response?.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      pending.resolve(response);
    }
  }

  #failPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export async function callRobot({ method, params, socketPath = DEFAULT_SOCKET }) {
  const client = new RobotClient({ socketPath });
  try {
    return await client.request(method, params);
  } finally {
    client.close();
  }
}
