import { createReadStream } from "node:fs";
import { lstat, mkdir, stat, unlink } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createUnixServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WebSocketServer, WebSocket } from "ws";

import { SimulatorBroker } from "./broker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(here, "../dist");
const DEFAULT_SOCKET = "/tmp/microduck-sim/robotd.sock";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".onnx", "application/octet-stream"],
  [".stl", "model/stl"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
]);

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    socketPath: DEFAULT_SOCKET,
    dist: DEFAULT_DIST,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--host" && value) {
      options.host = value;
      i++;
    } else if (argv[i] === "--port" && value) {
      options.port = Number(value);
      i++;
    } else if (argv[i] === "--socket" && value) {
      options.socketPath = value;
      i++;
    } else if (argv[i] === "--dist" && value) {
      options.dist = path.resolve(value);
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return options;
}

async function prepareSocket(socketPath) {
  await mkdir(path.dirname(socketPath), { recursive: true });
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeSocket(socketPath) {
  try {
    const existing = await lstat(socketPath);
    if (existing.isSocket()) await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function writeHttpError(response, statusCode, message) {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function createStaticHandler(dist) {
  const root = path.resolve(dist);
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return writeHttpError(response, 405, "method not allowed");
    }
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"ok":true}\n');
    }
    if (url.pathname === "/" && !url.searchParams.has("gateway")) {
      response.writeHead(302, { location: "/?gateway=auto" });
      return response.end();
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return writeHttpError(response, 400, "bad path");
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      return writeHttpError(response, 403, "forbidden");
    }
    try {
      if (!(await stat(file)).isFile()) return writeHttpError(response, 404, "not found");
    } catch (error) {
      if (error.code === "ENOENT") return writeHttpError(response, 404, "not found");
      throw error;
    }

    response.writeHead(200, {
      "content-type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(file).pipe(response);
  };
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(...args);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createBridge({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  socketPath = DEFAULT_SOCKET,
  dist = DEFAULT_DIST,
} = {}) {
  const broker = new SimulatorBroker();
  const serveStatic = createStaticHandler(dist);
  const http = createHttpServer((request, response) => {
    serveStatic(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) writeHttpError(response, 500, "internal server error");
      else response.destroy(error);
    });
  });
  const webSockets = new WebSocketServer({ noServer: true });
  const unix = createUnixServer();
  const liveSockets = new Set();

  http.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host ?? "localhost"}`).pathname;
    if (pathname !== "/simulator" && pathname !== "/rpc") return socket.destroy();
    webSockets.handleUpgrade(request, socket, head, (ws) => {
      webSockets.emit("connection", ws, request, pathname);
    });
  });

  webSockets.on("connection", (ws, _request, pathname) => {
    // A dropped client is ordinary. Without an error listener, ws promotes
    // transport errors into uncaught EventEmitter exceptions.
    ws.on("error", () => {});
    if (pathname === "/simulator") {
      const send = (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      };
      const receive = broker.attachSimulator(send);
      ws.on("message", (message) => receive(message.toString()));
      ws.on("close", () => broker.detachSimulator(send));
      return;
    }

    const client = broker.attachClient((message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    });
    ws.on("message", (message) => client.receive(message.toString()));
    ws.on("close", client.detach);
  });

  unix.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    const client = broker.attachClient((message) => socket.write(`${message}\n`));
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) client.receive(line);
      }
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
      client.detach();
    });
  });

  return {
    async listen() {
      await stat(path.join(dist, "index.html"));
      await prepareSocket(socketPath);
      try {
        await Promise.all([listen(http, port, host), listen(unix, socketPath)]);
      } catch (error) {
        await Promise.allSettled([close(http), close(unix), removeSocket(socketPath)]);
        throw error;
      }
      return { host, port: http.address().port, socketPath };
    },

    async close() {
      for (const socket of liveSockets) socket.destroy();
      for (const ws of webSockets.clients) ws.terminate();
      await Promise.all([close(http), close(unix)]);
      await removeSocket(socketPath);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridge = createBridge(options);
  const address = await bridge.listen();
  console.log(`Microduck simulator: http://${address.host}:${address.port}/`);
  console.log(`WebSocket JSON-RPC: ws://${address.host}:${address.port}/rpc`);
  console.log(`robotd socket: ${address.socketPath}`);

  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
