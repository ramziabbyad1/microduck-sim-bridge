import assert from "node:assert/strict";
import test from "node:test";

import { ApiSource, MicroduckRpc } from "../src/game/controls/api.js";
import { GatewayTransport, gatewayUrlFromLocation } from "../src/game/rpc/gateway-transport.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  readyState = FakeWebSocket.OPEN;
  sent = [];
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    this.#listeners.set(name, listener);
  }

  emit(name, data) {
    this.#listeners.get(name)?.({ data });
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

test("gateway=auto resolves to the page's WebSocket origin", () => {
  assert.equal(
    gatewayUrlFromLocation({ protocol: "http:", host: "127.0.0.1:8080", search: "?gateway=auto" }),
    "ws://127.0.0.1:8080/simulator",
  );
  assert.equal(
    gatewayUrlFromLocation({ protocol: "https:", host: "duck.example", search: "?gateway=auto" }),
    "wss://duck.example/simulator",
  );
});
test("gateway envelopes are translated to plain Microduck JSON-RPC", () => {
  FakeWebSocket.instances.length = 0;
  const source = new ApiSource();
  const rpc = new MicroduckRpc({ source });
  const transport = new GatewayTransport({
    rpc,
    url: "ws://localhost/simulator",
    WebSocketImpl: FakeWebSocket,
  });
  transport.init();
  const socket = FakeWebSocket.instances[0];

  socket.emit("message", JSON.stringify({
    clientId: "client-7",
    request: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "robot.stop" }),
  }));

  assert.deepEqual(JSON.parse(socket.sent[0]), {
    clientId: "client-7",
    response: { jsonrpc: "2.0", id: 4, result: { accepted: true } },
  });
  transport.dispose();
});

test("notifications are forwarded to the source without response traffic", () => {
  FakeWebSocket.instances.length = 0;
  const source = new ApiSource();
  const rpc = new MicroduckRpc({ source });
  const transport = new GatewayTransport({
    rpc,
    url: "ws://localhost/simulator",
    WebSocketImpl: FakeWebSocket,
  });
  transport.init();
  const socket = FakeWebSocket.instances[0];

  socket.emit("message", JSON.stringify({
    clientId: "client-8",
    request: JSON.stringify({
      jsonrpc: "2.0",
      method: "robot.move",
      params: { vx: 0.2, vy: 0, vyaw: 0.1 },
    }),
  }));

  assert.equal(source.isActive(), true);
  assert.deepEqual(socket.sent, []);
  transport.dispose();
});
