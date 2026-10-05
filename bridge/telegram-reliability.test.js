const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const https = require("node:https");
process.env.NODE_ENV = "test";
const {
  createTelegramStreamer,
  splitTelegramText,
  trackCallerDisconnect,
} = require("./agentcore-contract");
const { readBody } = require("./read-body");

function stubTelegramApi(responseForRequest) {
  const originalRequest = https.request;
  const requests = [];
  https.request = (options, onResponse) => {
    const request = new EventEmitter();
    request.end = (payload) => {
      requests.push({ options, body: JSON.parse(payload) });
      const response = new EventEmitter();
      process.nextTick(() => {
        onResponse(response);
        response.emit(
          "data",
          Buffer.from(JSON.stringify(responseForRequest(requests.length))),
        );
        response.emit("end");
      });
    };
    request.destroy = () => {};
    return request;
  };
  return {
    requests,
    restore: () => {
      https.request = originalRequest;
    },
  };
}

describe("contract Telegram reliability", () => {
  it("splits long text within UTF-16 limits without breaking surrogate pairs", () => {
    const text = `${"😀".repeat(2100)} tail`;
    const chunks = splitTelegramText(text, 4000);

    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
    }
  });

  it("prefers a paragraph boundary when splitting a reply", () => {
    const text = `${"a".repeat(2100)}\n\n${"b".repeat(2100)}`;
    const chunks = splitTelegramText(text, 4000);

    assert.equal(chunks[0], `${"a".repeat(2100)}\n\n`);
    assert.equal(chunks.join(""), text);
  });

  it("detects only a caller that closed before the response finished", () => {
    const response = new EventEmitter();
    response.writableFinished = false;
    response.destroyed = false;
    response.socket = { destroyed: false };
    const callerGone = trackCallerDisconnect(response);

    assert.equal(callerGone(), false);
    response.emit("close");
    assert.equal(callerGone(), true);

    const finished = new EventEmitter();
    finished.writableFinished = true;
    finished.destroyed = true;
    finished.socket = { destroyed: true };
    const finishedCallerGone = trackCallerDisconnect(finished);
    finished.emit("close");
    assert.equal(finishedCallerGone(), false);
  });

  it("decodes UTF-8 correctly when a character spans request chunks", async () => {
    const bytes = Buffer.from(JSON.stringify({ message: "hello 😀" }));
    const splitAt = bytes.indexOf(Buffer.from("😀")) + 2;
    const body = await readBody(
      Readable.from([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]),
    );
    assert.deepEqual(JSON.parse(body), { message: "hello 😀" });
  });

  it("leaves normal Telegram delivery to Router but sends orphaned replies", async () => {
    const telegram = stubTelegramApi((messageId) => ({
      ok: true,
      result: { message_id: messageId },
    }));
    try {
      const normal = createTelegramStreamer("123");
      assert.deepEqual(await normal.finalize("**formatted reply**"), {
        messageId: null,
      });
      assert.equal(telegram.requests.length, 0);

      const orphaned = createTelegramStreamer("123");
      const text = "😀".repeat(2100);
      const result = await orphaned.finalize(text, { callerGone: true });
      assert.deepEqual(result, { messageId: 2 });
      assert.equal(telegram.requests.length, 2);
      const chunks = telegram.requests.map((request) => request.body.text);
      assert.equal(chunks.join(""), text);
      assert.ok(chunks.every((chunk) => chunk.length <= 4000));
    } finally {
      telegram.restore();
    }
  });
});
