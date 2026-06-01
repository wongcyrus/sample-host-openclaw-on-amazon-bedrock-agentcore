const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  fetchGatewaySnapshot,
  streamGatewayEvents,
} = require("./dashboard-gateway");

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static acceptedProtocol = 4;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = MockWebSocket.OPEN;
    this.protocolVersion = null;
    this.requestCount = 0;
    MockWebSocket.instances.push(this);
    process.nextTick(() => {
      this.emit("message", JSON.stringify({
        type: "event",
        event: "connect.challenge",
      }));
    });
  }

  send(payload, cb) {
    const msg = JSON.parse(payload);

    if (msg.method === "connect") {
      this.protocolVersion = msg.params.maxProtocol;
      if (this.protocolVersion !== MockWebSocket.acceptedProtocol) {
        process.nextTick(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: {
              message: "protocol mismatch",
              details: {
                code: "PROTOCOL_MISMATCH",
                expectedProtocol: MockWebSocket.acceptedProtocol,
              },
            },
          }));
        });
      } else {
        process.nextTick(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: {},
          }));
        });
      }
      cb?.();
      return;
    }

    this.requestCount += 1;
    const payloadByMethod = {
      "agents.list": {
        agents: [{ id: "agent-1" }, { id: "agent-2" }],
      },
      "sessions.list": {
        sessions: [{ sessionKey: "global" }],
      },
      "system-presence": [],
      "agent.identity.get": {
        identity: { name: "demo" },
      },
    };

    process.nextTick(() => {
      this.emit("message", JSON.stringify({
        type: "res",
        id: msg.id,
        ok: true,
        payload: payloadByMethod[msg.method] || {},
      }));
    });
    cb?.();
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

describe("fetchGatewaySnapshot", () => {
  it("fetches snapshot data from the gateway using protocol 4", async () => {
    MockWebSocket.instances = [];
    MockWebSocket.acceptedProtocol = 4;

    const snapshot = await fetchGatewaySnapshot({
      token: "secret-token",
      port: 18789,
      wsImpl: MockWebSocket,
    });

    assert.equal(MockWebSocket.instances.length, 1);
    assert.equal(MockWebSocket.instances[0].options.origin, "http://127.0.0.1:18789");
    assert.equal(MockWebSocket.instances[0].protocolVersion, 4);
    assert.deepStrictEqual(snapshot.agents.agents.map((agent) => agent.id), [
      "agent-1",
      "agent-2",
    ]);
    assert.deepStrictEqual(snapshot.sessions.sessions, [{ sessionKey: "global" }]);
    assert.ok(snapshot.identities["agent-1"]);
    assert.ok(snapshot.identities["agent-2"]);
  });

  it("retries once with the server-advertised protocol on mismatch", async () => {
    MockWebSocket.instances = [];
    MockWebSocket.acceptedProtocol = 4;

    const snapshot = await fetchGatewaySnapshot({
      token: "secret-token",
      port: 18789,
      protocolVersion: 3,
      wsImpl: MockWebSocket,
    });

    assert.equal(MockWebSocket.instances.length, 2);
    assert.equal(MockWebSocket.instances[0].protocolVersion, 3);
    assert.equal(MockWebSocket.instances[1].protocolVersion, 4);
    assert.equal(snapshot.source, "ws://127.0.0.1:18789");
  });
});

class StreamingMockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static acceptedProtocol = 4;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = StreamingMockWebSocket.OPEN;
    this.protocolVersion = null;
    StreamingMockWebSocket.instances.push(this);
    process.nextTick(() => {
      this.emit("open");
      this.emit("message", JSON.stringify({
        type: "event",
        event: "connect.challenge",
      }));
    });
  }

  send(payload, cb) {
    const msg = JSON.parse(payload);
    if (msg.method === "connect") {
      this.protocolVersion = msg.params.maxProtocol;
      if (this.protocolVersion !== StreamingMockWebSocket.acceptedProtocol) {
        process.nextTick(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: {
              message: "protocol mismatch",
              details: {
                code: "PROTOCOL_MISMATCH",
                expectedProtocol: StreamingMockWebSocket.acceptedProtocol,
              },
            },
          }));
        });
      } else {
        process.nextTick(() => {
          this.emit("message", JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: {},
          }));
          this.emit("message", JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              sessionKey: "agent:alpha",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello dashboard" }],
              },
            },
          }));
          this.emit("message", JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "run-1",
              stream: "thought",
              sessionKey: "agent:alpha",
              data: {
                chunk: "thinking",
              },
            },
          }));
          this.emit("message", JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "run-1",
              sessionKey: "agent:alpha",
              data: {
                phase: "end",
              },
            },
          }));
        });
      }
      cb?.();
    }
  }

  close() {
    this.readyState = StreamingMockWebSocket.CLOSED;
  }
}

describe("streamGatewayEvents", () => {
  it("normalizes chat and agent events for dashboard clients", async () => {
    StreamingMockWebSocket.instances = [];
    const statuses = [];
    const events = [];

    const stream = streamGatewayEvents({
      token: "secret-token",
      port: 18789,
      wsImpl: StreamingMockWebSocket,
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      onError: (err) => {
        throw err;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.close();

    assert.equal(StreamingMockWebSocket.instances.length, 1);
    assert.equal(statuses[0].status, "connecting");
    assert.equal(statuses[1].status, "connected");
    assert.deepStrictEqual(events[0], {
      type: "agent-message",
      runId: "run-1",
      role: "assistant",
      content: "hello dashboard",
      sessionKey: "agent:alpha",
      agentId: "alpha",
    });
    assert.deepStrictEqual(events[1], {
      type: "agent-message-final",
      runId: "run-1",
      state: "final",
      agentId: "alpha",
    });
    assert.deepStrictEqual(events[2], {
      type: "agent-stream",
      runId: "run-1",
      stream: "thought",
      chunk: "thinking",
      agentId: "alpha",
    });
    assert.deepStrictEqual(events[3], {
      type: "agent-lifecycle",
      runId: "run-1",
      phase: "end",
      agentId: "alpha",
    });
  });

  it("retries stream connection once on protocol mismatch", async () => {
    StreamingMockWebSocket.instances = [];
    StreamingMockWebSocket.acceptedProtocol = 4;
    const statuses = [];

    const stream = streamGatewayEvents({
      token: "secret-token",
      port: 18789,
      protocolVersion: 3,
      wsImpl: StreamingMockWebSocket,
      onStatus: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.close();

    assert.equal(StreamingMockWebSocket.instances.length, 2);
    assert.equal(StreamingMockWebSocket.instances[0].protocolVersion, 3);
    assert.equal(StreamingMockWebSocket.instances[1].protocolVersion, 4);
    assert.equal(statuses.at(-1).status, "connected");
  });
});
