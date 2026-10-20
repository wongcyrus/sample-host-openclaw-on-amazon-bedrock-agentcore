const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const {
  CONTROL_UI_HEADER, CONTROL_UI_ORIGIN, CONTROL_UI_START, controlUiConfig, parseControlUiRoute,
  fetchControlUi, classifyControlUiPath, runDeviceCommand, proxyControlUi,
} = require("./control-ui");

test("both container build paths include the Control UI module", () => {
  for (const name of ["Dockerfile", "Dockerfile.cdk"]) {
    assert.match(fs.readFileSync(path.join(__dirname, name), "utf8"),
      /COPY (?:bridge\/)?control-ui\.js \/app\//);
  }
});

test("Control UI is opt-in and dev-only with exact origins and normal token/device auth", () => {
  for (const env of [{}, { OPENCLAW_ENVIRONMENT: "prod", OPENCLAW_CONTROL_UI: "1" }]) {
    assert.deepEqual(controlUiConfig(env), { enabled: false });
    assert.throws(() => parseControlUiRoute("{}", { env, userId: "owner", ready: true }));
  }
  const config = controlUiConfig({ OPENCLAW_ENVIRONMENT: "dev", OPENCLAW_CONTROL_UI: "1" });
  assert.deepEqual(config, { enabled: true, allowedOrigins: [CONTROL_UI_ORIGIN] });
  assert.equal(config.dangerouslyDisableDeviceAuth, undefined);
});

test("route requires the initialized session owner and an exact localhost origin", () => {
  const context = { env: { OPENCLAW_ENVIRONMENT: "dev", OPENCLAW_CONTROL_UI: "1" },
    userId: "owner", ready: true };
  const valid = JSON.stringify({ userId: "owner", origin: CONTROL_UI_ORIGIN });
  assert.deepEqual(parseControlUiRoute(valid, context), JSON.parse(valid));
  for (const value of ["bad", "{}", JSON.stringify({ userId: "other", origin: CONTROL_UI_ORIGIN }),
    JSON.stringify({ userId: "owner", origin: "https://evil.example" })]) {
    assert.throws(() => parseControlUiRoute(value, context));
  }
  assert.throws(() => parseControlUiRoute(valid, { ...context, ready: false }));
  assert.match(CONTROL_UI_HEADER, /^x-amzn-bedrock-agentcore-runtime-custom-/);
});

test("HTTP fetch serves actual gateway assets and preserves status, MIME and HTTP auth", async () => {
  let request;
  const server = http.createServer((req, res) => {
    request = req;
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end("bundled UI");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await fetchControlUi({ path: "/assets/bundle.js", authorization: "Bearer test" },
      { port: server.address().port });
    assert.equal(Buffer.from(result.body, "base64").toString(), "bundled UI");
    assert.equal(result.headers["content-type"], "application/javascript");
    assert.equal(request.headers.authorization, "Bearer test");
    for (const path of ["//evil", "/../openclaw.json", "/assets/%2e%2e/secrets", "/invocations",
      "/assets/a?url=http://evil", "/assets\\secrets"]) {
      await assert.rejects(fetchControlUi({ path }));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("pairing approval invokes only the supported CLI with an explicitly chosen request", async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: '{"pending":[]}', stderr: "" }; };
  await runDeviceCommand({ command: "list" }, { run, env: { HOME: "/private" } });
  await runDeviceCommand({ command: "approve", requestId: "abc-123" }, { run });
  assert.deepEqual(calls[0][1], ["devices", "list", "--json"]);
  assert.deepEqual(calls[1][1], ["devices", "approve", "abc-123", "--json"]);
  for (const payload of [{ command: "approve" }, { command: "clear" },
    { command: "approve", requestId: "--latest" }]) {
    await assert.rejects(runDeviceCommand(payload, { run }));
  }
  assert.equal(calls.length, 2);
});

test("native read routes are explicit and encoded sessions are retained without arbitrary proxying", () => {
  for (const path of ["/chat/main", "/settings/devices", "/focus/main",
    "/api/users/gateway-owner/avatar?v=3", "/avatar/main?meta=1",
    "/__openclaw__/workspace-icon/agent%3Amain%3Amain",
    "/__openclaw__/channel-avatar/agent%3Amain%3Amain?v=2",
    "/__openclaw__/plugin-activity-icon/example?tool=search",
    "/__openclaw__/catalog-icon/https%3A%2F%2Fexample.com%2Ficon.png",
    "/__openclaw__/plugin-theme-art/example/dark/background/art",
    "/__openclaw__/sw.js", "/assets/index.js?v=2026"]) {
    assert.ok(classifyControlUiPath(path), path);
  }
  for (const path of ["/api/users/gateway-owner", "/api/users/gateway-owner/avatar/extra",
    "/__openclaw__/workspace-icon/main/extra", "/__openclaw__/assistant-media?source=secret",
    "/plugins/example/api", "/v1/chat/completions", "/health", "/rpc",
    "/chat/%2e%2e", "/chat/%2fsecret", "/chat/%5csecret", "/chat/%ZZ",
    "/assets/%252e%252e/secret", "/assets/a?url=https://example.com",
    "/avatar/main?meta=1&meta=0", "/control-ui-config.json?token=secret"]) {
    assert.equal(classifyControlUiPath(path), null, path);
  }
});

test("native GET and HEAD keep missing images and readiness statuses, and SPA Accept enables fallback", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, accept: req.headers.accept });
    res.writeHead(req.url.startsWith("/api/") ? 404 : req.url.startsWith("/__openclaw__/") ? 503 : 200,
      { "Content-Type": "text/html", "Retry-After": "1", "Content-Length": "6" });
    res.end("native");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = { port: server.address().port };
    assert.equal((await fetchControlUi({ path: "/api/users/gateway-owner/avatar" }, options)).status, 404);
    const icon = await fetchControlUi({ path: "/__openclaw__/workspace-icon/agent%3Amain%3Amain" }, options);
    assert.equal(icon.status, 503);
    assert.equal(icon.headers["retry-after"], "1");
    const head = await fetchControlUi({ path: "/control-ui-config.json", method: "HEAD" }, options);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], "6");
    await fetchControlUi({ path: "/chat/main", method: "HEAD" }, options);
    assert.deepEqual(requests.at(-1), { method: "HEAD", path: "/chat/main", accept: "text/html" });
    await assert.rejects(fetchControlUi({ path: "/", method: "POST" }, options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("raw proxy preserves challenge and device-signed frames, marks remote pairing and closes peers", async () => {
  const upstream = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  const listener = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await Promise.all([upstream, listener].map((server) =>
    new Promise((resolve) => server.once("listening", resolve))));
  let headers;
  upstream.on("connection", (ws, req) => {
    headers = req.headers;
    ws.send('{"type":"event","event":"connect.challenge","payload":{"nonce":"real-nonce"}}');
    ws.on("message", (data) => { ws.send(data.toString()); ws.close(1008, "pairing required"); });
  });

  listener.on("connection", (ws) => proxyControlUi(ws, { origin: CONTROL_UI_ORIGIN },
    { port: upstream.address().port }));
  const client = new WebSocket(`ws://127.0.0.1:${listener.address().port}`);
  client.on("open", () => client.send(CONTROL_UI_START));
  const messages = [];
  client.on("message", (data) => {
    messages.push(data.toString());
    if (messages.length === 1) client.send('{"device":{"signature":"unchanged"}}');
  });

  test("raw route rejects native frames before the relay-only kickoff", async () => {
    const listener = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => listener.once("listening", resolve));
    listener.on("connection", (ws) => proxyControlUi(ws, { origin: CONTROL_UI_ORIGIN }, { port: 1 }));
    const client = new WebSocket(`ws://127.0.0.1:${listener.address().port}`);
    client.on("open", () => client.send('{"method":"connect"}'));
    const code = await new Promise((resolve) => client.once("close", resolve));
    assert.equal(code, 1008);
    await new Promise((resolve) => listener.close(resolve));
  });
  const closed = await new Promise((resolve) => client.on("close", (code, reason) =>
    resolve([code, reason.toString()])));
  assert.match(messages[0], /real-nonce/);
  assert.equal(messages[1], '{"device":{"signature":"unchanged"}}');
  assert.equal(headers.origin, CONTROL_UI_ORIGIN);
  assert.equal(headers["x-forwarded-for"], "192.0.2.1");
  assert.deepEqual(closed, [1008, "pairing required"]);
  await Promise.all([upstream, listener].map((server) =>
    new Promise((resolve) => server.close(resolve))));
});
