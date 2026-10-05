const { after, before, it } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.NODE_ENV = "test";

const WebSocket = require("ws");
const { bridgeMessage } = require("./agentcore-contract");

const PORT = 18789;
const MAIN_SESSION = "agent:main:main";
let gateway;

before(async () => {
  gateway = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  await once(gateway, "listening");
});

after(async () => {
  await new Promise((resolve) => gateway.close(resolve));
});

it("returns the owned run's successor final, not a subagent final", async () => {
  const deltas = [];
  gateway.once("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: message.id, ok: true }));
        return;
      }
      if (message.method !== "chat.send") return;

      const mainRunId = message.params.idempotencyKey;
      socket.send(JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: { status: "started", runId: mainRunId, sessionKey: MAIN_SESSION },
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId: mainRunId,
          sessionKey: MAIN_SESSION,
          state: "delta",
          message: { content: [{ type: "text", text: "main partial" }] },
        },
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId: "subagent-run",
          sessionKey: "agent:main:subagent:child",
          spawnedBy: MAIN_SESSION,
          state: "final",
          message: { content: [{ type: "text", text: "wrong subagent final" }] },
        },
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId: mainRunId,
          sessionKey: MAIN_SESSION,
          state: "final",
          yielded: true,
        },
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId: "successor-run",
          sessionKey: MAIN_SESSION,
          state: "final",
          message: { content: [{ type: "text", text: "successor final" }] },
        },
      }));
    });
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "test" },
    }));
  });

  const response = await bridgeMessage(
    "hello",
    3000,
    (text) => deltas.push(text),
    4,
    false,
    undefined,
    "telegram:123",
    "telegram",
    "test-token",
  );

  assert.equal(response, "successor final");
  assert.deepEqual(deltas, ["main partial"]);
});
