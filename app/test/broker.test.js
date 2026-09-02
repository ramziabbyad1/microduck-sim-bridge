import assert from "node:assert/strict";
import test from "node:test";

import { SimulatorBroker } from "../bridge/broker.js";
import { ApiSource, MicroduckRpc } from "../src/game/controls/api.js";

test("broker routes an answered request through the simulator", () => {
  const broker = new SimulatorBroker();
  const source = new ApiSource();
  const rpc = new MicroduckRpc({ source });
  const clientMessages = [];
  const client = broker.attachClient((message) => clientMessages.push(message));

  const receiveFromSimulator = broker.attachSimulator((rawEnvelope) => {
    const envelope = JSON.parse(rawEnvelope);
    const response = rpc.receive(envelope.request);
    if (response !== null) {
      receiveFromSimulator(JSON.stringify({ clientId: envelope.clientId, response }));
    }
  });

  client.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "robot.stop" }));

  assert.deepEqual(JSON.parse(clientMessages[0]), {
    jsonrpc: "2.0",
    id: 2,
    result: { accepted: true },
  });
});
test("broker returns a useful error when no simulator tab is connected", () => {
  const broker = new SimulatorBroker();
  const clientMessages = [];
  const client = broker.attachClient((message) => clientMessages.push(message));

  client.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "robot.stop" }));

  const response = JSON.parse(clientMessages[0]);
  assert.equal(response.id, 3);
  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /not connected/);
});
