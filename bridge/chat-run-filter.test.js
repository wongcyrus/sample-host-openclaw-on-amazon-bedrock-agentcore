const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createChatRunTracker,
  isSubagentSessionKey,
} = require("./chat-run-filter");

const MAIN_SESSION = "agent:main:main";
const SUBAGENT_SESSION = "agent:main:subagent:child";

describe("chat run ownership", () => {
  it("ignores subagent events and other runs without a matching owner", () => {
    const tracker = createChatRunTracker("main-run");
    tracker.adoptAck({ runId: "main-run", sessionKey: MAIN_SESSION });

    assert.deepEqual(
      tracker.classify({
        runId: "child-run",
        sessionKey: SUBAGENT_SESSION,
        spawnedBy: MAIN_SESSION,
        state: "final",
      }),
      { action: "ignore", reason: "subagent" },
    );
    assert.deepEqual(
      tracker.classify({
        runId: "other-run",
        sessionKey: MAIN_SESSION,
        state: "final",
      }),
      { action: "ignore", reason: "other-run" },
    );
  });

  it("follows yielded successor runs only in the owned session", () => {
    const tracker = createChatRunTracker("main-run");
    tracker.adoptAck({ runId: "main-run", sessionKey: MAIN_SESSION });

    assert.equal(
      tracker.classify({
        runId: "main-run",
        sessionKey: MAIN_SESSION,
        state: "final",
        yielded: true,
      }).action,
      "yield",
    );
    assert.equal(
      tracker.classify({
        runId: "child-run",
        sessionKey: SUBAGENT_SESSION,
        state: "final",
      }).action,
      "ignore",
    );
    assert.deepEqual(
      tracker.classify({
        runId: "successor-run",
        sessionKey: MAIN_SESSION,
        state: "final",
      }),
      { action: "accept", reason: "successor-run" },
    );
    assert.equal(tracker.state.runId, "successor-run");
  });

  it("recognizes subagent session key formats", () => {
    assert.equal(isSubagentSessionKey("subagent:abc"), true);
    assert.equal(isSubagentSessionKey("AGENT:main:subagent:abc"), true);
    assert.equal(isSubagentSessionKey(MAIN_SESSION), false);
  });

  it("wires filtering before chat state handling and adopts the ack", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "agentcore-contract.js"),
      "utf8",
    );
    const chatStart = source.indexOf('msg.event === "chat"');
    const responseStart = source.indexOf("// Step 4", chatStart);
    const chatHandler = source.slice(chatStart, responseStart);
    assert.ok(chatHandler.indexOf("chatRun.classify(payload)") >= 0);
    assert.ok(chatHandler.indexOf("chatRun.classify(payload)") <
      chatHandler.indexOf('payload.state === "final"'));
    assert.match(source, /chatRun\.adoptAck\(msg\.payload\)/);
  });
});
