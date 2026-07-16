const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

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
});
