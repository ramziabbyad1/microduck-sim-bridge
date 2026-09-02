const JSONRPC_VERSION = "2.0";
const SIMULATOR_UNAVAILABLE = -32000;

function unavailableResponse(raw) {
  try {
    const request = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      request === null ||
      typeof request !== "object" ||
      !("id" in request) ||
      request.id === null
    ) return null;
    return JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: request.id,
      error: { code: SIMULATOR_UNAVAILABLE, message: "simulator is not connected" },
    });
  } catch {
    return JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }
}
export class SimulatorBroker {
  #simulator = null;
  #clients = new Map();
  #nextClientId = 1;

  attachSimulator(send) {
    const simulator = { send };
    this.#simulator = simulator;
    return (raw) => this.#receiveFromSimulator(simulator, raw);
  }

  detachSimulator(send) {
    if (this.#simulator?.send === send) this.#simulator = null;
  }

  attachClient(send) {
    const clientId = `client-${this.#nextClientId++}`;
    this.#clients.set(clientId, send);
    return {
      clientId,
      receive: (raw) => this.#receiveFromClient(clientId, raw),
      detach: () => this.#clients.delete(clientId),
    };
  }

  #receiveFromClient(clientId, raw) {
    if (!this.#simulator) {
      const response = unavailableResponse(raw);
      if (response !== null) this.#clients.get(clientId)?.(response);
      return;
    }
    this.#simulator.send(JSON.stringify({ clientId, request: raw }));
  }

  #receiveFromSimulator(simulator, raw) {
    if (this.#simulator !== simulator) return;
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      typeof envelope.clientId !== "string" ||
      !("response" in envelope)
    ) return;
    const response = typeof envelope.response === "string"
      ? envelope.response
      : JSON.stringify(envelope.response);
    this.#clients.get(envelope.clientId)?.(response);
  }
}
