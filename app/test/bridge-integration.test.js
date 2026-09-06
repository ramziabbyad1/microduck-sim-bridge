import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { WebSocket } from "ws";

import { createBridge } from "../bridge/server.js";
import { ApiSource, MicroduckRpc } from "../src/game/controls/api.js";
import { callRobotDo } from "../tools/robot-do.js";
import { driveRobot } from "../tools/robot-move.js";
import { callRobotState } from "../tools/robot-state.js";

const openWebSocket = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.once("open", () => resolve(socket));
  socket.once("error", reject);
});

const openUnixSocket = (socketPath) => new Promise((resolve, reject) => {
  const socket = net.createConnection(socketPath);
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
});

const nextLine = (socket) => new Promise((resolve, reject) => {
  let buffered = "";
  const onData = (chunk) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline === -1) return;
    cleanup();
    resolve(buffered.slice(0, newline));
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
  };
  socket.setEncoding("utf8");
  socket.on("data", onData);
  socket.on("error", onError);
});

test("real NDJSON and WebSocket clients reach the simulated API", { timeout: 5_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "microduck-bridge-test-"));
  const socketPath = path.join(temporary, "robotd.sock");
  const bridge = createBridge({ port: 0, socketPath });
  const address = await bridge.listen();
  t.after(async () => {
    await bridge.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const source = new ApiSource();
  const rpc = new MicroduckRpc({
    source,
    getState: () => ({
      ready: true,
      inputLocked: false,
      locomotion: "legs",
      mode: "walk",
      moving: source.isActive(),
    }),
  });
  let apiAction = null;
  source.onAction = (action, meta) => {
    apiAction = { action, skill: meta.skill };
    return { accepted: true };
  };
  const simulator = await openWebSocket(`ws://127.0.0.1:${address.port}/simulator`);
  t.after(() => simulator.close());
  simulator.on("message", (raw) => {
    const envelope = JSON.parse(raw.toString());
    const response = rpc.receive(envelope.request);
    if (response !== null) {
      simulator.send(JSON.stringify({ clientId: envelope.clientId, response }));
    }
  });

  const unix = await openUnixSocket(socketPath);
  t.after(() => unix.destroy());
  const unixResponse = nextLine(unix);
  unix.write('{"jsonrpc":"2.0","id":11,"method":"robot.stop"}\n');
  assert.deepEqual(JSON.parse(await unixResponse), {
    jsonrpc: "2.0",
    id: 11,
    result: { accepted: true },
  });

  assert.deepEqual(await callRobotDo({ skill: "kick_left", socketPath }), {
    jsonrpc: "2.0",
    id: 1,
    result: { accepted: true },
  });
  assert.deepEqual(apiAction, { action: "kickL", skill: "kick_left" });

  assert.deepEqual(await callRobotState({ socketPath }), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      ready: true,
      inputLocked: false,
      locomotion: "legs",
      mode: "walk",
      moving: false,
    },
  });

  const movement = await driveRobot({
    direction: "right",
    seconds: 0.05,
    rate: 50,
    socketPath,
  });
  assert.equal(movement.direction, "turn-right");
  assert.equal(source.isActive(), false);
  assert.deepEqual(Array.from(source.command), [0, 0, 0]);

  const webSocketClient = await openWebSocket(`ws://127.0.0.1:${address.port}/rpc`);
  t.after(() => webSocketClient.close());
  const webSocketResponse = new Promise((resolve) => {
    webSocketClient.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  webSocketClient.send(JSON.stringify({
    jsonrpc: "2.0",
    id: "move-1",
    method: "robot.move",
    params: { vx: 0.2, vy: -0.1, vyaw: 0.3 },
  }));

  assert.deepEqual(await webSocketResponse, {
    jsonrpc: "2.0",
    id: "move-1",
    result: { accepted: true },
  });
  assert.deepEqual(Array.from(source.command), [
    Math.fround(0.2),
    Math.fround(-0.1),
    Math.fround(0.3),
  ]);
});
