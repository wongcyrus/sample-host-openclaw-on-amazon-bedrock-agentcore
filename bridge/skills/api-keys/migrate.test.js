const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STUB = `
const Module = require("module");
const fs = require("fs");
const original = Module._load;
Module._load = function(request, ...args) {
  if (request !== "@aws-sdk/client-secrets-manager") return original.call(this, request, ...args);
  const commands = Object.fromEntries(["GetSecretValueCommand", "PutSecretValueCommand",
    "CreateSecretCommand", "DeleteSecretCommand"].map(name => [name, class {
      constructor(input) { this.name = name; this.input = input; }
    }]));
  return { ...commands, SecretsManagerClient: class {
    async send(cmd) {
      fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(cmd) + "\\n");
      const mode = process.env.STUB_MODE;
      if (mode === "deny" || (mode === "write-denied" && cmd.name === "PutSecretValueCommand")
        || (mode === "create-denied" && cmd.name === "CreateSecretCommand")) {
        throw Object.assign(new Error("Access denied"), {name: "AccessDeniedException"});
      }
      if (mode === "create-denied" && cmd.name === "PutSecretValueCommand") {
        throw Object.assign(new Error("Not found"), {name: "ResourceNotFoundException"});
      }
      if (cmd.name === "GetSecretValueCommand") {
        if (mode === "binary") return { SecretBinary: Buffer.from("x") };
        return { SecretString: mode === "empty" ? "" : "secret-value" };
      }
      return {};
    }
  }};
};
`;

describe("standalone API key migration", () => {
  let home, stub, log, keys;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(__dirname, ".migration-test-"));
    stub = path.join(home, "sm-stub.js");
    log = path.join(home, "commands.log");
    keys = path.join(home, ".openclaw", "user-api-keys.json");
    fs.writeFileSync(stub, STUB);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  function write(raw) {
    fs.mkdirSync(path.dirname(keys), { recursive: true });
    fs.writeFileSync(keys, raw);
  }
  function run(script, args, mode = "") {
    return spawnSync(process.execPath, ["-r", stub, path.join(__dirname, script), "telegram_123", ...args], {
      env: { PATH: process.env.PATH, HOME: home, AWS_REGION: "us-west-2", STUB_LOG: log, STUB_MODE: mode },
      encoding: "utf8", timeout: 20000,
    });
  }
  function calls() {
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  }

  it("secure-to-native writes before scheduling seven-day recovery deletion", () => {
    write(JSON.stringify({ other: "keep" }));
    const result = run("migrate.js", ["demo", "secure-to-native"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(keys)), { other: "keep", demo: "secret-value" });
    const deletion = calls().find((c) => c.name === "DeleteSecretCommand");
    assert.equal(deletion.input.RecoveryWindowInDays, 7);
    assert.equal("ForceDeleteWithoutRecovery" in deletion.input, false);
  });

  for (const mode of ["deny", "binary", "empty"]) {
    it(`preserves native data and secure source after read failure (${mode})`, () => {
      const before = JSON.stringify({ other: "keep" });
      write(before);
      const result = run("migrate.js", ["demo", "secure-to-native"], mode);
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(keys, "utf8"), before);
      assert.equal(calls().some((c) => c.name === "DeleteSecretCommand"), false);
    });
  }

  for (const raw of ['{"other":"keep"', "[]", "null"]) {
    it(`refuses corrupt native data (${raw}) for migrate and native set`, () => {
      write(raw);
      assert.notEqual(run("migrate.js", ["demo", "secure-to-native"]).status, 0);
      assert.notEqual(run("native.js", ["set", "demo", "new-value"]).status, 0);
      assert.equal(fs.readFileSync(keys, "utf8"), raw);
      assert.equal(calls().some((c) => c.name === "DeleteSecretCommand"), false);
    });
  }

  it("preserves secure source after native write failure", () => {
    write(JSON.stringify({ other: "keep" }));
    fs.mkdirSync(keys + ".tmp");
    assert.notEqual(run("migrate.js", ["demo", "secure-to-native"]).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(keys)), { other: "keep" });
    assert.equal(calls().some((c) => c.name === "DeleteSecretCommand"), false);
  });

  it("preserves secure source when native path is unreadable", () => {
    fs.mkdirSync(keys, { recursive: true });
    const result = run("migrate.js", ["demo", "secure-to-native"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unreadable/);
    assert.equal(calls().some((c) => c.name === "DeleteSecretCommand"), false);
  });

  for (const mode of ["write-denied", "create-denied"]) {
    it(`preserves native source after secure write failure (${mode})`, () => {
      const before = JSON.stringify({ demo: "native-value", other: "keep" });
      write(before);
      assert.notEqual(run("migrate.js", ["demo", "native-to-secure"], mode).status, 0);
      assert.equal(fs.readFileSync(keys, "utf8"), before);
    });
  }

  it("native-to-secure removes only the migrated key after a successful write", () => {
    write(JSON.stringify({ demo: "native-value", other: "keep" }));
    const result = run("migrate.js", ["demo", "native-to-secure"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(keys)), { other: "keep" });
    assert.equal(calls()[0].input.SecretString, "native-value");
  });

  it("missing native store can be created by migration and native set", () => {
    assert.equal(run("migrate.js", ["demo", "secure-to-native"]).status, 0);
    assert.equal(run("native.js", ["set", "other", "new-value"]).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(keys)), { demo: "secret-value", other: "new-value" });
  });
});
