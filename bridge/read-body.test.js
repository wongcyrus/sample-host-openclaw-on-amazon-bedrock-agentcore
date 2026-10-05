const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { readBody } = require("./read-body");

describe("readBody UTF-8 request decoding", () => {
  for (const text of ['{"message":"你好世界"}', "a😀b", "東京".repeat(20000)]) {
    it(`preserves split characters (${Buffer.byteLength(text)} bytes)`, async () => {
      const req = new EventEmitter();
      const result = readBody(req);
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i++) req.emit("data", bytes.subarray(i, i + 1));
      req.emit("end");
      assert.equal(await result, text);
    });
  }

  it("counts limits in bytes, accepting an exact cap", async () => {
    for (const limit of [11, 12]) {
      const req = new EventEmitter();
      const result = readBody(req, limit);
      req.emit("data", Buffer.from("你好世界"));
      req.emit("end");
      if (limit === 11) await assert.rejects(result, { code: "BODY_TOO_LARGE" });
      else assert.equal(await result, "你好世界");
    }
  });

  it("handles empty bodies and propagates stream errors/aborts", async () => {
    const empty = new EventEmitter();
    const result = readBody(empty);
    empty.emit("end");
    assert.equal(await result, "");
    for (const event of ["error", "aborted"]) {
      const req = new EventEmitter();
      const result = readBody(req);
      req.emit(event, new Error("request failed"));
      await assert.rejects(result);
    }
  });

  it("proxy uses shared byte reader rather than per-chunk string concatenation", () => {
    const src = fs.readFileSync(path.join(__dirname, "agentcore-proxy.js"), "utf8");
    assert.match(src, /require\("\.\/read-body"\)/);
    assert.match(src, /readBody\(req\b/);
    assert.doesNotMatch(src, /req\.on\("data"/);
  });
});
