const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
const contract = require("./agentcore-contract");

const ORIGINAL_ENV = {
  LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
  LITELLM_API_KEY: process.env.LITELLM_API_KEY,
  LITELLM_MODELS_JSON: process.env.LITELLM_MODELS_JSON,
  LITELLM_PRIMARY_MODEL_ID: process.env.LITELLM_PRIMARY_MODEL_ID,
  LITELLM_SUBAGENT_MODEL_ID: process.env.LITELLM_SUBAGENT_MODEL_ID,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("OpenClaw model config", () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("keeps the original AgentCore model ids when LiteLLM is disabled", () => {
    delete process.env.LITELLM_BASE_URL;

    const config = contract.buildOpenClawModelConfig({ env: process.env });

    assert.equal(config.activeProvider, "agentcore");
    assert.equal(config.primaryModelRef, "agentcore/bedrock-agentcore");
    assert.equal(config.subagentModelRef, "agentcore/bedrock-agentcore-subagent");
    assert.ok(config.providers.agentcore);
    assert.equal(config.providers.agentcore.models[0].id, "bedrock-agentcore");
    assert.equal(config.providers.agentcore.models[1].id, "bedrock-agentcore-subagent");
  });

  it("builds LiteLLM model refs from env-configured ids", () => {
    process.env.LITELLM_BASE_URL = "https://litellm.example.invalid/v1";
    process.env.LITELLM_API_KEY = "test-key";
    process.env.LITELLM_MODELS_JSON = JSON.stringify([
      { id: "kimi-k2.5", name: "kimi-k2.5", contextWindow: 300000 },
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", contextWindow: 128000 },
    ]);
    process.env.LITELLM_PRIMARY_MODEL_ID = "kimi-k2.5";
    process.env.LITELLM_SUBAGENT_MODEL_ID = "gpt-5.4-mini";

    const config = contract.buildOpenClawModelConfig({
      env: process.env,
    });

    assert.equal(config.activeProvider, "litellm");
    assert.equal(config.primaryModelRef, "litellm/kimi-k2.5");
    assert.equal(config.subagentModelRef, "litellm/gpt-5.4-mini");
    assert.ok(config.providers.litellm);
    assert.equal(config.providers.litellm.baseUrl, "https://litellm.example.invalid/v1");
    assert.equal(config.providers.litellm.apiKey, "test-key");
    assert.equal(config.providers.litellm.headers.Authorization, "Bearer test-key");
    assert.equal(config.providers.litellm.headers["x-api-key"], "test-key");
    assert.equal(config.providers.litellm.models.length, 2);
  });

  it("normalizes Bearer-prefixed keys from env", () => {
    process.env.LITELLM_BASE_URL = "https://litellm.example.invalid/v1";
    process.env.LITELLM_API_KEY = "Bearer test-key";
    process.env.LITELLM_MODELS_JSON = JSON.stringify([
      { id: "kimi-k2.5", name: "kimi-k2.5", contextWindow: 300000 },
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", contextWindow: 128000 },
    ]);
    process.env.LITELLM_PRIMARY_MODEL_ID = "kimi-k2.5";
    process.env.LITELLM_SUBAGENT_MODEL_ID = "gpt-5.4-mini";

    const config = contract.buildOpenClawModelConfig({
      env: process.env,
    });

    assert.equal(config.providers.litellm.apiKey, "test-key");
    assert.equal(config.providers.litellm.headers.Authorization, "Bearer test-key");
    assert.equal(config.providers.litellm.headers["x-api-key"], "test-key");
  });

  it("fails fast when LiteLLM ids do not match the catalog", () => {
    process.env.LITELLM_BASE_URL = "https://litellm.example.invalid/v1";
    process.env.LITELLM_API_KEY = "test-key";
    process.env.LITELLM_MODELS_JSON = JSON.stringify([
      { id: "kimi-k2.5", name: "kimi-k2.5" },
    ]);
    process.env.LITELLM_PRIMARY_MODEL_ID = "kimi-k2.5";
    process.env.LITELLM_SUBAGENT_MODEL_ID = "gpt-5.4-mini";

    assert.throws(
      () =>
        contract.buildOpenClawModelConfig({
          env: process.env,
        }),
      /LITELLM_SUBAGENT_MODEL_ID 'gpt-5\.4-mini' was not found in LITELLM_MODELS_JSON/,
    );
  });

  it("writes the 2026.9.7 explicit agent roster and model policy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-test-"));
    const oldHome = process.env.HOME;
    const oldHumanoid = process.env.HUMANOID_MCP_SERVER_URL;
    try {
      process.env.HOME = home;
      process.env.HUMANOID_MCP_SERVER_URL = "https://example.invalid/mcp";
      delete process.env.LITELLM_BASE_URL;
      const config = contract.writeOpenClawConfig({ gatewayToken: "test-token" });
      assert.equal(config.agents.ownership, "explicit");
      assert.equal(config.agents.list, undefined);
      assert.deepEqual(Object.keys(config.agents.entries), [
        "main", "domain-commentator", "communication-manager",
        "robot_1", "robot_2", "robot_3", "robot_4", "robot_5", "robot_6",
      ]);
      assert.ok(Object.values(config.agents.entries).every((entry) => entry.id === undefined));
      assert.deepEqual(config.agents.defaults.systemAgent, { agentId: "main" });
      assert.deepEqual(config.agents.defaults.heartbeat, { agentId: "main" });
      assert.deepEqual(config.agents.defaults.modelPolicy.allow, [
        "agentcore/bedrock-agentcore", "agentcore/bedrock-agentcore-subagent",
      ]);
      assert.ok(config.agents.entries.robot_1.tools.deny.includes("view_image"));
      assert.ok(config.agents.entries.robot_1.tools.deny.includes("x_search"));
      assert.deepEqual(config.channels, {});
      assert.deepEqual(config.cron, { enabled: false });
      assert.deepEqual(config.gateway.controlUi, { enabled: false });
      assert.equal(config.tools.exec.mode, "full");
      assert.equal(config.tools.exec.security, undefined);
      assert.equal(config.tools.exec.ask, undefined);
      assert.equal(config.agents.entries.robot_1.tools.exec.mode, "full");
      assert.equal(config.gateway.auth.token, "test-token");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".openclaw/openclaw.json"))), config);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldHumanoid === undefined) delete process.env.HUMANOID_MCP_SERVER_URL;
      else process.env.HUMANOID_MCP_SERVER_URL = oldHumanoid;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
