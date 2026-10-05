const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
const { migrateOpenClawWorkspace } = require("./agentcore-contract");

it("does not run doctor for a fresh workspace", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
  try {
    assert.equal(await migrateOpenClawWorkspace({ HOME: home }, "/nonexistent-openclaw"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("runs safe offline repairs for restored databases and propagates failures", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
  try {
    const agentDir = path.join(home, ".openclaw/agents/main/agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "openclaw-agent.sqlite"), "fixture");
    const binary = path.join(home, "openclaw");
    fs.writeFileSync(binary, `#!${process.execPath}
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"]);
assert.equal(process.env.INTERNAL_USER_ID, "migration-test-user");
assert.equal(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined);
require("fs").writeFileSync(process.env.HOME + "/migrated", "ok");
`, { mode: 0o700 });
    assert.equal(await migrateOpenClawWorkspace({ HOME: home, INTERNAL_USER_ID: "migration-test-user" }, binary), true);
    assert.equal(fs.readFileSync(path.join(home, "migrated"), "utf8"), "ok");
    fs.writeFileSync(binary, `#!${process.execPath}
console.error("media migration failed");
process.exitCode = 78;
`, { mode: 0o700 });
    await assert.rejects(
      migrateOpenClawWorkspace({ HOME: home }, binary),
      /Offline OpenClaw migration failed: media migration failed/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
