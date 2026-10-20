const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("real deployed bundled UI reaches native gateway and requires explicit browser pairing", {
  skip: !process.env.OPENCLAW_CONTROL_UI_LOGIN_URL && "Start the dev relay and supply its private login URL",
  timeout: 180000,
}, async () => {
  const workspace = path.resolve(__dirname, "../.bedrock_agentcore/control-ui-verification");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  // Chromium's singleton Unix socket has a short path limit.
  const browserRuntime = path.relative(process.cwd(), workspace);
  process.env.TMPDIR = browserRuntime;
  const { chromium } = require("playwright-core");
  const profile = path.join(workspace, `profile-${process.pid}-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.OPENCLAW_UI_BROWSER_BINARY || "/usr/bin/google-chrome",
    headless: true, serviceWorkers: "block", args: ["--disable-dev-shm-usage"],
    env: { ...process.env, TMPDIR: browserRuntime },
  });
  try {
    await context.route("**/*", (route) => new URL(route.request().url()).origin === "http://127.0.0.1:18795"
      ? route.continue() : route.abort());
    const page = await context.newPage();
    let challenge = false, pairing = false, deviceId, connectClient, connectVersion, requestId;
    const assets = new Set();
    const failedPaths = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/assets/") && response.status() === 200) assets.add(url.pathname);
      if (response.status() >= 400) failedPaths.push({ path: url.pathname, status: response.status() });
    });
    page.on("websocket", (socket) => {
      assert.equal(new URL(socket.url()).origin, "ws://127.0.0.1:18795");
      socket.on("framereceived", ({ payload }) => {
        let frame;
        try { frame = JSON.parse(payload.toString()); } catch { return; }
        if (frame.event === "connect.challenge" && frame.payload?.nonce) challenge = true;
        if (frame.error?.details?.code === "PAIRING_REQUIRED") {
          pairing = true;
          requestId = frame.error.details.requestId;
        }
      });
      socket.on("framesent", ({ payload }) => {
        let frame;
        try { frame = JSON.parse(payload.toString()); } catch { return; }
        if (frame.method === "connect") {
          deviceId = frame.params?.device?.id;
          connectClient = frame.params?.client?.id;
          connectVersion = frame.params?.client?.version;
        }
      });
    });
    try {
      const response = await page.goto(process.env.OPENCLAW_CONTROL_UI_LOGIN_URL,
        { waitUntil: "commit", timeout: 120000 });
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => /approve this browser|waiting for approval|pairing required|pending approval/i
        .test(document.body.innerText),
        null, { timeout: 120000 });
      const originalDeviceId = deviceId;
      await page.reload({ waitUntil: "commit", timeout: 60000 });
      await page.waitForFunction(() => /approve this browser|waiting for approval|pairing required|pending approval/i
        .test(document.body.innerText), null, { timeout: 60000 });
      assert.equal(deviceId, originalDeviceId, "Reload replaced the browser's pairing identity");
      assert.ok(!await page.getByText("This Gateway expects its token", { exact: true }).count(),
        "Reload lost the native gateway token");
    } catch (error) {
      fs.writeFileSync(path.join(workspace, "failure.json"), JSON.stringify({
        nativeChallenge: challenge, pairingRequired: pairing, deviceId, connectClient, connectVersion, requestId,
        failedPaths, errors, profile,
        body: await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000)).catch(() => ""),
      }, null, 2), { mode: 0o600 });
      await page.screenshot({ path: path.join(workspace, "failure.png"), fullPage: true });
      throw error;
    }
    assert.ok(challenge, "Native gateway challenge was not received");
    assert.ok(pairing, "Native signed browser connect did not return PAIRING_REQUIRED");
    assert.ok(deviceId, "Bundled UI did not supply its browser device identity");
    assert.equal(connectClient, "openclaw-control-ui");
    assert.match(connectVersion, /^2026\.9\.7(?:$|[-+])/);
    assert.ok(assets.has("/assets/index-BLeYLjXu.js"), "UI entry asset differs from openclaw@2026.9.7");
    assert.ok(assets.size > 0, "No actual bundled assets fetched from the runtime");
    assert.ok(!page.url().includes("token="), "Gateway token fragment was not consumed by the bundled UI");
    const summary = { nativeChallenge: challenge, pairingRequired: pairing, deviceId, connectClient, connectVersion, requestId,
      assets: [...assets], pageTitle: await page.title(), session: "existing Telegram dev session",
      approved: false, nativeReloadVerified: true, profile };
    fs.writeFileSync(path.join(workspace, "result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    await page.screenshot({ path: path.join(workspace, "pairing.png"), fullPage: true });
  } finally {
    await context.close();
  }
});
