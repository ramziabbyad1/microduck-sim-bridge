import assert from "node:assert/strict";
import test from "node:test";

import { driveRobot, moveParams, parseMoveArgs } from "../tools/robot-move.js";
import { runRobotDemo } from "../tools/robot-demo.js";

class FakeRobotClient {
  requests = [];
  notifications = [];
  stateCalls = 0;

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "robot.get_state") {
      this.stateCalls++;
      return {
        jsonrpc: "2.0",
        id: this.requests.length,
        result: this.stateCalls === 1
          ? {
              ready: true,
              inputLocked: false,
              locomotion: "legs",
              mode: "walk",
              activeSkill: null,
            }
          : { ready: true, locomotion: "legs", mode: "kickL", activeSkill: "kick_left" },
      };
    }
    return {
      jsonrpc: "2.0",
      id: this.requests.length,
      result: { accepted: true },
    };
  }

  async notify(method, params) {
    this.notifications.push({ method, params });
  }
}

test("movement directions map aliases to conservative twists", () => {
  assert.deepEqual(moveParams("up"), { vx: 0.25, vy: 0, vyaw: 0 });
  assert.deepEqual(moveParams("forward", 0.2), { vx: 0.2, vy: 0, vyaw: 0 });
  assert.deepEqual(moveParams("down", 0.1), { vx: -0.1, vy: 0, vyaw: 0 });
  assert.deepEqual(moveParams("left"), { vx: 0, vy: 0, vyaw: 0.6 });
  assert.deepEqual(moveParams("right", 0.4), { vx: 0, vy: 0, vyaw: -0.4 });
});

test("movement CLI parses duration, speed, rate, and socket", () => {
  assert.deepEqual(parseMoveArgs([
    "left",
    "--seconds", "2.5",
    "--speed", "0.7",
    "--rate", "25",
    "--socket", "/tmp/example.sock",
  ]), {
    direction: "turn-left",
    seconds: 2.5,
    speed: 0.7,
    rate: 25,
    socketPath: "/tmp/example.sock",
  });
  assert.throws(() => parseMoveArgs(["sideways"]), /direction must be one of/);
  assert.throws(() => parseMoveArgs(["forward", "--seconds", "0"]), /seconds/);
});

test("driveRobot always stops after streaming movement", async () => {
  const client = new FakeRobotClient();
  const result = await driveRobot({
    client,
    direction: "forward",
    seconds: 0.05,
    rate: 50,
  });

  assert.equal(result.direction, "forward");
  assert.deepEqual(client.requests.map(({ method }) => method), ["robot.move", "robot.stop"]);
  assert.ok(client.notifications.length >= 1);
  assert.ok(client.notifications.every(({ method }) => method === "robot.move"));
});

test("driveRobot sends stop when movement is interrupted", async () => {
  const client = new FakeRobotClient();
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(driveRobot({
    client,
    direction: "forward",
    seconds: 0.05,
    signal: abort.signal,
  }), /interrupted/);
  assert.deepEqual(client.requests.map(({ method }) => method), ["robot.move", "robot.stop"]);
});

test("demo moves, settles, then kicks from an idle legs state", async () => {
  const client = new FakeRobotClient();
  const lines = [];
  const result = await runRobotDemo({
    client,
    forwardSeconds: 0.05,
    turnSeconds: 0.05,
    settleMs: 0,
    log: (line) => lines.push(line),
  });

  assert.deepEqual(client.requests.map(({ method }) => method), [
    "robot.get_state",
    "robot.move",
    "robot.stop",
    "robot.move",
    "robot.stop",
    "robot.do",
    "robot.get_state",
  ]);
  assert.deepEqual(client.requests[1].params, moveParams("forward"));
  assert.deepEqual(client.requests[5].params, { skill: "kick_left" });
  assert.equal(result.final.activeSkill, "kick_left");
  assert.match(lines.at(-1), /Standing still/);
});
