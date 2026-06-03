const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WORKSPACE_FILES,
  PROXY_CONTEXT_FILES,
  buildAgentWorkspaceDir,
  getAgentWorkspaceS3Candidates,
  getManagedWorkspaceS3Candidates,
  getWorkspaceDefaults,
  getWorkspaceDefaultsByAgent,
} = require("./workspace-files");

test("workspace defaults include per-agent AGENTS and TOOLS guidance", () => {
  const defaults = getWorkspaceDefaults({
    browserEnabled: true,
    humanoidEnabled: true,
  });

  assert.ok(defaults["AGENTS.md"].includes("Use runtime-provided startup context first"));
  assert.ok(defaults["AGENTS.md"].includes("node /skills/eventbridge-cron/create.js"));
  assert.ok(defaults["TOOLS.md"].includes("s3-user-files"));
  assert.ok(defaults["TOOLS.md"].includes("humanoid"));
});

test("robot workspace defaults specialize AGENTS and IDENTITY by robot id", () => {
  const defaults = getWorkspaceDefaults({
    humanoidEnabled: true,
  }, "robot_2");

  assert.ok(defaults["AGENTS.md"].includes("# robot_2 Agent"));
  assert.ok(defaults["AGENTS.md"].includes("physical unit `robot_2`"));
  assert.ok(defaults["IDENTITY.md"].includes("`robot_2`"));
  assert.ok(defaults["TOOLS.md"].includes("`robot_2`"));
});

test("workspace defaults by agent preserve robot-specific templates", () => {
  const defaultsByAgent = getWorkspaceDefaultsByAgent(
    { humanoidEnabled: true },
    ["main", "robot_1", "robot_2"],
  );

  assert.ok(defaultsByAgent.main["IDENTITY.md"].includes("HKIIT"));
  assert.ok(defaultsByAgent.robot_1["AGENTS.md"].includes("# robot_1 Agent"));
  assert.ok(defaultsByAgent.robot_2["IDENTITY.md"].includes("`robot_2`"));
  assert.notEqual(
    defaultsByAgent.robot_1["AGENTS.md"],
    defaultsByAgent.main["AGENTS.md"],
  );
});

test("workspace files preserve AGENTS and TOOLS priority", () => {
  const filenames = WORKSPACE_FILES.map((wf) => wf.filename);
  assert.deepEqual(
    filenames,
    ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md"],
  );
});

test("proxy context files include persona and identity defaults", () => {
  assert.deepEqual(
    PROXY_CONTEXT_FILES.map((wf) => wf.filename),
    ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"],
  );
});

test("agent workspace helpers return per-agent paths and S3 fallback order", () => {
  assert.equal(
    buildAgentWorkspaceDir("/root", "robot_2"),
    "/root/.openclaw/workspaces/robot_2",
  );
  assert.deepEqual(
    getAgentWorkspaceS3Candidates("telegram_123", "robot_2", "AGENTS.md"),
    ["telegram_123/agents/robot_2/AGENTS.md"],
  );
  assert.deepEqual(
    getAgentWorkspaceS3Candidates("telegram_123", "robot_2", "USER.md"),
    [
      "telegram_123/agents/robot_2/USER.md",
      "telegram_123/USER.md",
    ],
  );
});

test("managed workspace candidates fall back to bootstrap namespace after user namespace", () => {
  assert.deepEqual(
    getManagedWorkspaceS3Candidates({
      namespace: "telegram_123",
      bootstrapNamespace: "workspace-bootstrap",
      agentId: "robot_2",
      filename: "USER.md",
    }),
    [
      "telegram_123/agents/robot_2/USER.md",
      "telegram_123/USER.md",
      "workspace-bootstrap/agents/robot_2/USER.md",
      "workspace-bootstrap/USER.md",
    ],
  );
});

test("managed workspace candidates avoid duplicate bootstrap lookups", () => {
  assert.deepEqual(
    getManagedWorkspaceS3Candidates({
      namespace: "workspace-bootstrap",
      bootstrapNamespace: "workspace-bootstrap",
      agentId: "main",
      filename: "AGENTS.md",
    }),
    [
      "workspace-bootstrap/agents/main/AGENTS.md",
      "workspace-bootstrap/AGENTS.md",
    ],
  );
});
