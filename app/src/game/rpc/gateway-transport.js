// Browser half of the local simulator gateway. The gateway envelopes messages
// only while routing them between clients; MicroduckRpc still receives and
// returns the physical robot's unmodified JSON-RPC payloads.

export function gatewayUrlFromLocation(locationLike = window.location) {
  const configured = new URLSearchParams(locationLike.search).get("gateway");
  if (!configured) return null;
  if (configured !== "auto") return configured;
  const scheme = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${locationLike.host}/simulator`;
}
export class GatewayTransport {
  connected = false;

  #rpc;
  #url;
  #WebSocket;
  #socket = null;
  #reconnectMs;
  #reconnectTimer = null;
  #disposed = false;

  constructor({
    rpc,
    url,
    WebSocketImpl = WebSocket,
    reconnectMs = 1_000,
  }) {
    this.#rpc = rpc;
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#reconnectMs = reconnectMs;
  }

  init() {
    this.#disposed = false;
    this.#connect();
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.close();
    this.#socket = null;
    this.connected = false;
  }

  #connect() {
    if (this.#disposed) return;
    const socket = new this.#WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket === socket) this.connected = true;
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#receive(socket, event.data);
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.connected = false;
      this.#socket = null;
      if (!this.#disposed) {
        this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectMs);
      }
    });
    socket.addEventListener("error", () => {
      // `close` owns reconnects. Browsers also log the useful URL/error.
    });
  }

  #receive(socket, rawEnvelope) {
    let envelope;
    try {
      envelope = JSON.parse(rawEnvelope);
    } catch {
      return;
    }
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      typeof envelope.clientId !== "string" ||
      !("request" in envelope)
    ) return;

    const response = this.#rpc.receive(envelope.request);
    if (response !== null && socket.readyState === this.#WebSocket.OPEN) {
      socket.send(JSON.stringify({ clientId: envelope.clientId, response }));
    }
  }
}
