const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { EventEmitter } = require("events");

// Set NODE_ENV to test to prevent contract server from listening automatically on load
process.env.NODE_ENV = "test";

const contract = require("./agentcore-contract");

describe("Direct Agent Routing", () => {
  let wss;
  const PORT = 18789; // Matches the constant in agentcore-contract.js

  before(async () => {
    // Start a mock WebSocket server on the contract's expected OpenClaw port
    return new Promise((resolve) => {
      wss = new WebSocket.Server({ port: PORT }, () => {
        console.log(`[test-ws] Mock OpenClaw WebSocket server listening on port ${PORT}`);
        resolve();
      });

      describe("gateway shutdown before final snapshot", () => {
        it("waits for the gateway to exit after SIGTERM", async () => {
          const child = new EventEmitter();
          child.exitCode = null;
          child.signalCode = null;
          let stopped = false;
          child.kill = (signal) => {
            assert.equal(signal, "SIGTERM");
            setImmediate(() => {
              stopped = true;
              child.emit("exit", 0);
            });
          };
          await contract.stopOpenClawProcess(child);
          assert.ok(stopped);
        });

        it("rejects rather than claiming a quiesced snapshot if the gateway will not stop", async () => {
          const child = new EventEmitter();
          child.exitCode = null;
          child.signalCode = null;
          child.kill = () => true;
          await assert.rejects(contract.stopOpenClawProcess(child, 10), /did not stop/);
          assert.equal(child.listenerCount("exit"), 0);
        });
      });
    });
  });

  after(() => {
    if (wss) {
      wss.close();
    }
  });

  it("sends chat.send request with sessionKey global when agentId is omitted", async () => {
    let capturedSessionKey = null;

    // Handle WebSocket interactions
    wss.once("connection", (ws) => {
      // Step 1: Send connect challenge
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge" }));

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.method === "connect") {
          // Step 2: Accept connect request
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
        } else if (msg.method === "chat.send") {
          // Step 3: Capture the sessionKey sent by the contract
          capturedSessionKey = msg.params?.sessionKey;
          // Respond to end the bridgeMessage call
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { status: "final" } }));
        }
      });
    });

    // Invoke bridgeMessage without agentId
    await contract.bridgeMessage("Hello global", 2000, undefined, 4, false);

    assert.equal(capturedSessionKey, "global");
  });

  it("sends chat.send request with sessionKey agent:domain-commentator when agentId is domain-commentator", async () => {
    let capturedSessionKey = null;

    // Handle WebSocket interactions
    wss.once("connection", (ws) => {
      // Step 1: Send connect challenge
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge" }));

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.method === "connect") {
          // Step 2: Accept connect request
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
        } else if (msg.method === "chat.send") {
          // Step 3: Capture the sessionKey sent by the contract
          capturedSessionKey = msg.params?.sessionKey;
          // Respond to end the bridgeMessage call
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { status: "final" } }));
        }
      });
    });

    // Invoke bridgeMessage with agentId = "domain-commentator"
    await contract.bridgeMessage(
      "Hello domain-commentator",
      2000,
      undefined,
      4,
      false,
      "domain-commentator"
    );

    assert.equal(capturedSessionKey, "agent:domain-commentator");
  });

  it("preserves actor and channel routing when retrying the advertised protocol", async () => {
    let capturedSessionKey;
    wss.once("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
      ws.once("message", (data) => {
        const request = JSON.parse(data);
        wss.once("connection", (retry) => {
          retry.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
          retry.on("message", (retryData) => {
            const message = JSON.parse(retryData);
            if (message.method === "connect") {
              assert.equal(message.params.maxProtocol, 5);
              retry.send(JSON.stringify({ type: "res", id: message.id, ok: true }));
            } else if (message.method === "chat.send") {
              capturedSessionKey = message.params.sessionKey;
              retry.send(JSON.stringify({ type: "res", id: message.id, ok: true, payload: { status: "final" } }));
            }
          });
        });
        ws.send(JSON.stringify({
          type: "res", id: request.id, ok: false,
          error: { details: { code: "PROTOCOL_MISMATCH", expectedProtocol: 5 } },
        }));
      });
    });
    await contract.bridgeMessage("hello", 2000, undefined, 4, true, "robot_1", "telegram:123", "telegram");
    assert.equal(capturedSessionKey, "agent:robot_1:telegram:telegram_123");
  });
});
