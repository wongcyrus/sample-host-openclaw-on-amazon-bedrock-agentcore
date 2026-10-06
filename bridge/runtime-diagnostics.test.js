const { it } = require("node:test");
const assert = require("node:assert/strict");
const { collectDiagnostics } = require("./runtime-diagnostics");
const fs = require("node:fs");
const path = require("node:path");

const config = {
  skills: { load: { extraDirs: ["/skills"] }, entries: {
    humanoid: { enabled: true, env: { MCP_SERVER_URL: "https://old.invalid/mcp" } },
  } },
};

it("ships diagnostic module in both container build paths", () => {
  for (const name of ["Dockerfile", "Dockerfile.cdk"]) {
    const text = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.match(text, /COPY (?:bridge\/)?runtime-diagnostics\.js \/app\//);
  }
});

it("reports actual skill configuration without secrets or arbitrary file reads", async () => {
  const result = await collectDiagnostics({
    env: { HOME: "/root", HUMANOID_MCP_SERVER_URL: "https://new.invalid/mcp" },
    readFile: async (file) => {
      assert.equal(file, "/root/.openclaw/openclaw.json");
      return JSON.stringify({ ...config, models: { apiKey: "secret-test-value" } });
    },
    run: async (command, args) => {
      assert.equal(command, "openclaw");
      assert.deepEqual(args, ["logs", "--limit", "500", "--max-bytes", "500000", "--json"]);
      return { stdout: '{"type":"meta","file":"/tmp/openclaw/test.log"}\n', stderr: "" };
    },
  });
  assert.equal(result.skills.humanoid.matchesRuntime, false);
  assert.equal(result.nativeLogs.includes('"type":"meta"'), true);
  assert.equal(JSON.stringify(result).includes("secret-test-value"), false);
});

it("rejects unbounded log requests before running a process", async () => {
  for (const limit of [0, 2001, "500", 1.5]) {
    await assert.rejects(collectDiagnostics({ limit }), /limit/);
  }
});

it("surfaces native log collection failure instead of a success-shaped result", async () => {
  await assert.rejects(collectDiagnostics({
    readFile: async () => JSON.stringify(config),
    run: async () => { throw new Error("gateway unavailable"); },
  }), /gateway unavailable/);
});

it("runs only the read-only skill connection check when requested", async () => {
  const commands = [];
  const result = await collectDiagnostics({
    checkMcp: true,
    readFile: async () => JSON.stringify(config),
    run: async (command, args) => {
      commands.push([command, args]);
      return {
        stdout: command === "openclaw" ? "" : '{"success":true,"httpStatus":200,"toolNames":["example"]}',
        stderr: "",
      };
    },
  });
  assert.deepEqual(commands[1], ["/skills/humanoid/run.sh", ["--check-connection"]]);
  assert.equal(result.mcpConnection.httpStatus, 200);
});
