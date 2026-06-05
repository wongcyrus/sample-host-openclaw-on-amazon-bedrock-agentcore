const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

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
});
