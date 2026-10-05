const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const shim = require("./lightweight-agent");

describe("API key migration preserves source on failure", () => {
  let home, originalHome, calls, send;
  const sdk = Object.fromEntries([
    "GetSecretValueCommand", "PutSecretValueCommand", "CreateSecretCommand",
    "DeleteSecretCommand", "ListSecretsCommand",
  ].map((name) => [name, class {
    constructor(input) { this.name = name; this.input = input; }
  }]));
  const fail = (name) => { throw Object.assign(new Error(name), { name }); };
  const migrate = (direction) => shim.executeMigrateApiKey({ key_name: "demo", direction }, "telegram_123");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(__dirname, ".batch1-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    calls = [];
    send = async () => ({ SecretString: "secret-value" });
    shim._secretsCache.clear();
    shim._setSecretsManagerForTests({
      async send(command) { calls.push(command); return send(command); },
    }, sdk);
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    shim._setSecretsManagerForTests(null, null);
    shim._secretsCache.clear();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("retrieve uses SM first, caches hits, and falls back after SDK errors", async () => {
    shim.writeApiKeys({ demo: "native-value" });
    assert.equal(await shim.executeRetrieveApiKey({ key_name: "demo" }, "telegram_123"), "secret-value");
    assert.equal(await shim.executeRetrieveApiKey({ key_name: "demo" }, "telegram_123"), "secret-value");
    assert.equal(calls.length, 1);
    shim._secretsCache.clear();
    send = async () => fail("AccessDeniedException");
    assert.equal(await shim.executeRetrieveApiKey({ key_name: "demo" }, "telegram_123"), "native-value");
  });

  for (const mode of ["put-failed", "create-failed", "limit"]) {
    it(`keeps native copy if secure write fails (${mode})`, async () => {
      shim.writeApiKeys({ demo: "native-value", other: "keep" });
      send = async (cmd) => {
        if (cmd.name === "PutSecretValueCommand") {
          return fail(mode === "put-failed" ? "AccessDeniedException" : "ResourceNotFoundException");
        }
        if (cmd.name === "ListSecretsCommand") {
          return { SecretList: mode === "limit" ? Array(10).fill({ Name: "x" }) : [] };
        }
        return fail("AccessDeniedException");
      };
      assert.match(await migrate("native-to-secure"), /^Error/);
      assert.deepEqual(shim.readApiKeys(), { demo: "native-value", other: "keep" });
      assert.equal(shim._secretsCache.size, 0);
    });
  }

  for (const response of [undefined, "", { binary: true }]) {
    it(`keeps secure copy when SecretString is unusable (${JSON.stringify(response)})`, async () => {
      send = async () => ({ SecretString: response });
      assert.match(await migrate("secure-to-native"), /^Error/);
      assert.equal(calls.length, 1);
      assert.equal(fs.existsSync(shim.getApiKeysPath()), false);
    });
  }

  it("does not write or delete after secure read error", async () => {
    shim.writeApiKeys({ other: "keep" });
    send = async () => fail("AccessDeniedException");
    assert.match(await migrate("secure-to-native"), /^Error: Could not read/);
    assert.deepEqual(shim.readApiKeys(), { other: "keep" });
    assert.equal(calls.length, 1);
  });

  for (const raw of ['{"other":"keep"', "[]", "null"]) {
    it(`keeps corrupt native bytes and secure source (${raw})`, async () => {
      fs.mkdirSync(path.dirname(shim.getApiKeysPath()), { recursive: true });
      fs.writeFileSync(shim.getApiKeysPath(), raw);
      assert.match(await migrate("secure-to-native"), /^Error:/);
      assert.match(shim.executeManageApiKey({ action: "set", key_name: "demo", key_value: "new" }), /^Error:/);
      assert.equal(fs.readFileSync(shim.getApiKeysPath(), "utf8"), raw);
      assert.equal(calls.length, 1);
    });
  }

  it("does not delete secure source when native write fails", async () => {
    fs.mkdirSync(path.dirname(shim.getApiKeysPath()), { recursive: true });
    fs.mkdirSync(shim.getApiKeysPath() + ".tmp");
    assert.match(await migrate("secure-to-native"), /^Error:/);
    assert.equal(calls.length, 1);
  });

  it("does not call Secrets Manager when the native source is corrupt", async () => {
    fs.mkdirSync(path.dirname(shim.getApiKeysPath()), { recursive: true });
    const raw = '{"demo":"native-value"';
    fs.writeFileSync(shim.getApiKeysPath(), raw);
    assert.match(await migrate("native-to-secure"), /^Error: native key file/);
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(shim.getApiKeysPath(), "utf8"), raw);
  });

  it("reports native cleanup failure without losing either copy", async () => {
    shim.writeApiKeys({ demo: "native-value", other: "keep" });
    send = async () => {
      fs.mkdirSync(shim.getApiKeysPath() + ".tmp");
      return {};
    };
    assert.match(await migrate("native-to-secure"), /^Error: Key copied to Secrets Manager/);
    assert.deepEqual(shim.readApiKeys(), { demo: "native-value", other: "keep" });
    assert.equal(shim._secretsCache.get("openclaw/user/telegram_123/demo"), "native-value");
  });

  it("successful migration uses seven-day recovery and preserves other keys", async () => {
    shim.writeApiKeys({ other: "keep" });
    assert.match(await migrate("secure-to-native"), /^Migrated/);
    assert.deepEqual(shim.readApiKeys(), { other: "keep", demo: "secret-value" });
    const deletion = calls.find((c) => c.name === "DeleteSecretCommand");
    assert.equal(deletion.input.RecoveryWindowInDays, 7);
    assert.equal("ForceDeleteWithoutRecovery" in deletion.input, false);
  });

  it("reports secure deletion failure after successful native copy", async () => {
    send = async (cmd) => cmd.name === "DeleteSecretCommand"
      ? fail("AccessDeniedException") : { SecretString: "secret-value" };
    assert.match(await migrate("secure-to-native"), /^Error: Key copied/);
    assert.equal(shim.readApiKeys().demo, "secret-value");
  });

  it("successful secure write removes only migrated native key", async () => {
    shim.writeApiKeys({ demo: "native-value", other: "keep" });
    assert.match(await migrate("native-to-secure"), /^Migrated/);
    assert.deepEqual(shim.readApiKeys(), { other: "keep" });
    assert.equal(calls[0].input.SecretString, "native-value");
  });
});

describe("connection-time DNS validation", () => {
  let originalLookup, originalGet;
  beforeEach(() => { originalLookup = dns.lookup; originalGet = http.get; });
  afterEach(() => { dns.lookup = originalLookup; http.get = originalGet; });
  const lookup = (opts = {}) => new Promise((resolve) =>
    shim._guardedLookup("public.test", opts, (err, address, family) => resolve({ err, address, family })));
  const answer = (addresses) => { dns.lookup = (host, opts, cb) => process.nextTick(() => cb(null, addresses)); };

  it("passes public IPv4/IPv6 candidates in all and single forms", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    answer(addresses);
    assert.deepEqual((await lookup({ all: true })).address, addresses);
    assert.equal((await lookup(4)).address, addresses[0].address);
  });

  it("rejects any blocked candidate, including normalized IPv4-mapped IPv6", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254",
      "::", "::1", "::ffff:7f00:1", "::ffff:100.64.0.1", "64:ff9b::a00:1", "fd12:3456::1", "fe80::1"]) {
      answer([{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]);
      assert.equal((await lookup()).err.code, "EBLOCKEDADDR", address);
    }
  });

  it("propagates DNS errors and rejects empty results", async () => {
    answer([]);
    assert.equal((await lookup()).err.code, "ENOTFOUND");
    dns.lookup = (host, opts, cb) => cb(new Error("DNS failed"));
    assert.match((await lookup()).err.message, /DNS failed/);
  });

  it("does not connect to loopback on initial or redirected rebinding", async () => {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push(req.url); res.end("INTERNAL-SECRET"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      answer([{ address: "127.0.0.1", family: 4 }]);
      const target = `http://rebind.test:${server.address().port}/`;
      assert.match(await shim.executeWebFetch(target), /^Error:/);
      let calls = 0;
      http.get = function (url, opts, cb) {
        if (++calls > 1) return originalGet.call(http, url, opts, cb);
        const req = new EventEmitter();
        process.nextTick(() => cb({ statusCode: 302, headers: { location: target }, resume() {} }));
        return req;
      };
      assert.match(await shim.executeWebFetch("http://public.test/"), /^Error:/);
      assert.deepEqual(hits, []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("blocks IP literals which bypass DNS", async () => {
    for (const address of ["::", "::1", "::ffff:7f00:1", "::ffff:100.64.0.1", "64:ff9b::7f00:1"]) {
      assert.match(await shim.executeWebFetch(`http://[${address}]/`), /^Error:/);
    }
  });
});

describe("HTTP UTF-8 response chunk decoding", () => {
  let originalGet, originalHttpsGet, originalRequest;
  beforeEach(() => {
    originalGet = http.get; originalHttpsGet = https.get; originalRequest = http.request;
  });
  afterEach(() => {
    http.get = originalGet; https.get = originalHttpsGet; http.request = originalRequest;
  });
  function responder(chunks) {
    return (url, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      const req = new EventEmitter();
      req.destroy = req.write = req.end = () => {};
      process.nextTick(() => {
        const res = new EventEmitter();
        Object.assign(res, { statusCode: 200, headers: {}, destroy() {}, resume() {} });
        cb(res);
        for (const chunk of chunks) res.emit("data", chunk);
        res.emit("end");
      });
      return req;
    };
  }
  const split = (text) => [...Buffer.from(text)].map((byte) => Buffer.from([byte]));

  it("web_fetch preserves CJK characters split across three reads", async () => {
    http.get = responder(split("<p>你好東京😀</p>"));
    assert.equal(await shim.executeWebFetch("http://public.test/"), "你好東京😀");
  });
  it("web_search preserves split CJK snippets", async () => {
    https.get = responder(split('<div class="result"><a class="result__a" href="https://example.com/">T</a><a class="result__snippet">東京の天気</a></div>'));
    assert.match(await shim.executeWebSearch("tokyo"), /東京の天気/);
  });
  it("chat proxy response preserves split CJK and emoji", async () => {
    http.request = responder(split(JSON.stringify({ choices: [{ message: { role: "assistant", content: "你好東京😀" } }] })));
    assert.match(await shim.chat("hi", "telegram:123"), /^你好東京😀/);
  });
  it("web_fetch still caps bytes, not character count", async () => {
    const body = Buffer.from("字".repeat(200 * 1024));
    const chunks = [];
    for (let i = 0; i < body.length; i += 65537) chunks.push(body.subarray(i, i + 65537));
    http.get = responder(chunks);
    assert.match(await shim.executeWebFetch("http://public.test/"), /\[Content truncated at size limit\]/);
  });
});
