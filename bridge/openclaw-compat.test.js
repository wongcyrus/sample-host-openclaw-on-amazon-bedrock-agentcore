const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const { setTimeout: delay } = require("timers/promises");

process.env.NODE_ENV = "test";
const contract = require("./agentcore-contract");
const { fetchGatewaySnapshot } = require("./dashboard-gateway");
const runFile = promisify(execFile);
const binary = process.env.OPENCLAW_COMPAT_BINARY;

it("validates both providers and exercises a real 2026.9.7 gateway", {
  skip: !binary && "Set OPENCLAW_COMPAT_BINARY to the installed 2026.9.7 CLI",
  timeout: 600000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compat-"));
  const previousEnv = { ...process.env };
  const token = "compatibility-test-token-not-a-secret";
  let gateway, logs = "", providerCalls = 0;
  const provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    providerCalls++;
    const answer = "Compatibility verified";
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const delta of [{ role: "assistant", content: answer }, {}]) {
        res.write(`data: ${JSON.stringify({
          id: "compat", object: "chat.completion.chunk", model: request.model,
          choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }],
        })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "compat", object: "chat.completion", model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
  });
  try {
    process.env.HOME = home;
    process.env.HUMANOID_MCP_SERVER_URL = "https://example.invalid/mcp";
    delete process.env.LITELLM_BASE_URL;
    const env = { ...process.env, OPENCLAW_SKIP_CRON: "1" };
    const version = await runFile(binary, ["--version"], { env, timeout: 60000 });
    assert.match(version.stdout, /2026\.9\.7/);
    contract.writeOpenClawConfig({ gatewayToken: token });
    await runFile(binary, ["config", "validate", "--json"], { env, timeout: 60000 });

    process.env.LITELLM_BASE_URL = "http://127.0.0.1:18790/v1";
    process.env.LITELLM_API_KEY = "compat-key";
    process.env.LITELLM_PRIMARY_MODEL_ID = "compat";
    process.env.LITELLM_SUBAGENT_MODEL_ID = "compat";
    process.env.LITELLM_MODELS_JSON = JSON.stringify([{ id: "compat", name: "Compatibility model" }]);
    contract.writeOpenClawConfig({ gatewayToken: token });
    await runFile(binary, ["config", "validate", "--json"], { env, timeout: 60000 });

    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(18790, "127.0.0.1", resolve);
    });
    gateway = spawn(binary, ["gateway", "run", "--port", "18789"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stdout.on("data", (chunk) => { logs += chunk; });
    gateway.stderr.on("data", (chunk) => { logs += chunk; });
    let snapshot, lastError;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      assert.equal(gateway.exitCode, null, logs);
      try {
        snapshot = await fetchGatewaySnapshot({ token, timeoutMs: 3000 });
        break;
      } catch (err) {
        lastError = err;
        await delay(500);
      }
    }
    assert.ok(snapshot, `${lastError?.message}\n${logs.slice(-12000)}`);
    const ids = snapshot.agents.agents.map((entry) => entry.id);
    assert.ok(ids.includes("main"));
    assert.ok(ids.includes("robot_6"));
    assert.ok(ids.includes("domain-commentator"));
    const answer = await contract.bridgeMessage(
      "Say compatibility verified", 180000, undefined, 4, true,
      "main", "telegram:compat", "telegram", token,
    );
    assert.match(answer, /Compatibility verified/, logs.slice(-12000));
    assert.ok(providerCalls > 0);
  } finally {
    if (gateway) {
      try {
        await contract.stopOpenClawProcess(gateway, 5000);
      } catch (err) {
        gateway.kill("SIGKILL");
        console.error(`Compatibility gateway cleanup required SIGKILL: ${err.message}`);
      }
    }
    await new Promise((resolve, reject) => {
      provider.close((err) => err && err.code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve());
    });
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
