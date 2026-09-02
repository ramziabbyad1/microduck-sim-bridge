import assert from "node:assert/strict";
import test from "node:test";

import { ApiSource, MicroduckRpc } from "../src/game/controls/api.js";
import { Controller } from "../src/game/controls/controller.js";

function harness() {
  let now = 1_000;
  const source = new ApiSource({ now: () => now });
  const rpc = new MicroduckRpc({ source });
  return {
    source,
    rpc,
    advance(ms) {
      now += ms;
      source.poll();
    },
  };
}

test("robot.move notifications drive the simulator without replying", () => {
  const { source, rpc } = harness();

  const response = rpc.receive({
    jsonrpc: "2.0",
    method: "robot.move",
    params: { vx: 0.2, vy: -0.1, vyaw: 0.4 },
  });

  assert.equal(response, null);
  assert.equal(source.isActive(), true);
  assert.deepEqual(Array.from(source.command), [
    Math.fround(0.2),
    Math.fround(-0.1),
    Math.fround(0.4),
  ]);
});

test("robot.move requests are accepted like the physical robot", () => {
  const { rpc } = harness();

  assert.deepEqual(
    rpc.receive({
      jsonrpc: "2.0",
      id: 7,
      method: "robot.move",
      params: { vx: 0.1 },
    }),
    { jsonrpc: "2.0", id: 7, result: { accepted: true } },
  );
});

test("robot.stop immediately zeroes movement", () => {
  const { source, rpc } = harness();
  rpc.receive({
    jsonrpc: "2.0",
    method: "robot.move",
    params: { vx: 0.2, vyaw: 0.4 },
  });

  const response = rpc.receive({ jsonrpc: "2.0", id: "stop-1", method: "robot.stop" });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: "stop-1",
    result: { accepted: true },
  });
  assert.deepEqual(Array.from(source.command), [0, 0, 0]);
});

test("robot.do translates every physical skill through the Controller", () => {
  const source = new ApiSource();
  const controller = new Controller({ sources: [source] });
  const rpc = new MicroduckRpc({ source });
  const expected = new Map([
    ["ground_pick", "groundPick"],
    ["kick_left", "kickL"],
    ["kick_right", "kickR"],
    ["sit_toggle", "sitToggle"],
    ["roulade", "roll"],
  ]);

  let id = 20;
  for (const [skill, action] of expected) {
    controller.on(action, (meta) => {
      assert.equal(meta.source, "api");
      assert.equal(meta.skill, skill);
      return { accepted: true };
    });
    assert.deepEqual(rpc.receive({
      jsonrpc: "2.0",
      id,
      method: "robot.do",
      params: { skill },
    }), {
      jsonrpc: "2.0",
      id,
      result: { accepted: true },
    });
    id++;
  }
});

test("robot.do returns a normal refusal with the simulator's reason", () => {
  const source = new ApiSource();
  const controller = new Controller({ sources: [source] });
  const rpc = new MicroduckRpc({ source });
  controller.on("kickL", () => ({
    accepted: false,
    reason: "kick_right is already running",
  }));

  assert.deepEqual(rpc.receive({
    jsonrpc: "2.0",
    id: 25,
    method: "robot.do",
    params: { skill: "kick_left" },
  }), {
    jsonrpc: "2.0",
    id: 25,
    result: { accepted: false, reason: "kick_right is already running" },
  });
});

test("robot.do rejects unknown skills and fields before dispatch", () => {
  const { source, rpc } = harness();
  let dispatched = false;
  source.onAction = () => { dispatched = true; };

  for (const params of [
    { skill: "moonwalk" },
    { skill: "kick_left", force: true },
    {},
  ]) {
    const response = rpc.receive({
      jsonrpc: "2.0",
      id: 26,
      method: "robot.do",
      params,
    });
    assert.equal(response.error.code, -32602);
  }
  assert.equal(dispatched, false);
});

test("the physical robot's 500 ms dead-man releases stale movement", () => {
  const { source, rpc, advance } = harness();
  rpc.receive({ jsonrpc: "2.0", method: "robot.move", params: { vx: 0.2 } });

  advance(500);
  assert.equal(source.isActive(), true);

  advance(1);
  assert.equal(source.isActive(), false);
  assert.deepEqual(Array.from(source.command), [0, 0, 0]);
});

test("invalid params do not mutate movement and return the standard error", () => {
  const { source, rpc } = harness();

  const response = rpc.receive({
    jsonrpc: "2.0",
    id: 8,
    method: "robot.move",
    params: { vx: 0.2, surprise: true },
  });

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /unknown field/);
  assert.equal(source.isActive(), false);
});

test("unknown request methods return method-not-found", () => {
  const { rpc } = harness();

  assert.deepEqual(
    rpc.receive({ jsonrpc: "2.0", id: 9, method: "robot.fly", params: {} }),
    {
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601, message: "method not found: robot.fly" },
    },
  );
});

test("malformed wire JSON returns a parse error", () => {
  const { rpc } = harness();
  const response = rpc.receive('{"jsonrpc":"2.0"');

  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
});
