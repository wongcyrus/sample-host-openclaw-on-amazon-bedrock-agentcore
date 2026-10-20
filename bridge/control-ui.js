const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const WebSocket = require("ws");
const UI_ROUTES = require("./control-ui-routes.json");

const CONTROL_UI_HEADER = "x-amzn-bedrock-agentcore-runtime-custom-control-ui";
const CONTROL_UI_ORIGIN = "http://127.0.0.1:18795";
const CONTROL_UI_START = '{"type":"openclaw-control-ui-start"}';
const MAX_BYTES = 8 * 1024 * 1024;
const STATIC_PATH = /^\/(?:favicon(?:\.ico|\.svg|-32\.png)$|apple-touch-icon\.png$|manifest\.webmanifest$|sw\.js$|(?:assets|fonts|themes|app-art|cloud-provider-icons|community-art|file-icons|provider-icons)\/[A-Za-z0-9_./-]+$)/;

function classifyControlUiPath(path) {
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") ||
      /[\\#\s]/.test(path) || path.includes("//")) return null;
  const [pathname, query = ""] = path.split("?");
  if (path.split("?").length > 2) return null;
  let segments;
  try { segments = pathname.split("/").map(decodeURIComponent); } catch { return null; }
  const catalogUrl = /^\/__openclaw__\/catalog-icon\/[^/]+$/.test(pathname);
  if (segments.some((part, index) => part === "." || part === ".." ||
      /[\\\x00-\x20\x7f]/.test(part) || (part.includes("/") && !(catalogUrl && index === 3)))) {
    return null;
  }
  if (catalogUrl) {
    try {
      const url = new URL(segments[3]);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    } catch { return null; }
  }
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const spa = UI_ROUTES.spaPaths.includes(normalized) ||
    UI_ROUTES.spaPrefixes.some((prefix) => pathname.startsWith(prefix));
  const config = UI_ROUTES.configPaths.includes(pathname);
  const staticAsset = STATIC_PATH.test(pathname) ||
    (pathname.startsWith("/__openclaw__/") && STATIC_PATH.test(pathname.slice(13)));
  const avatar = /^\/avatar\/[^/]+$/.test(pathname);
  const userAvatar = /^\/api\/users\/[^/]+\/avatar$/.test(pathname);
  const resource = /^\/__openclaw__\/([^/]+)\/(.+)$/.exec(pathname);
  const resourceName = resource?.[1];
  const nativeResource = UI_ROUTES.resources.includes(resourceName) &&
    resource[2].split("/").length === (resourceName === "plugin-theme-art" ? 4 : 1) &&
    resource[2].split("/").every(Boolean);
  if (!spa && !config && !staticAsset && !avatar && !userAvatar && !nativeResource) return null;
  const allowedQueries = spa ? UI_ROUTES.navigationQueries :
    avatar ? ["v", "meta"] : resourceName === "plugin-activity-icon" ? ["v", "tool"] : ["v"];
  const params = new URLSearchParams(query);
  const seen = new Set();
  for (const [key, value] of params) {
    if (!allowedQueries.includes(key) || seen.has(key) || value.length > 512 ||
        /[\x00-\x1f\x7f]/.test(value)) return null;
    seen.add(key);
  }
  return { spa, authenticated: config || avatar || userAvatar || nativeResource };
}

function controlUiConfig(env = process.env) {
  return env.OPENCLAW_ENVIRONMENT === "dev" && env.OPENCLAW_CONTROL_UI === "1"
    ? { enabled: true, allowedOrigins: [CONTROL_UI_ORIGIN] }
    : { enabled: false };
}

function parseControlUiRoute(value, { env = process.env, userId, ready }) {
  if (!controlUiConfig(env).enabled || !ready || !userId) throw new Error("Control UI unavailable");
  if (typeof value !== "string" || value.length > 1024) throw new Error("Invalid Control UI route");
  const route = JSON.parse(value);
  if (route.userId !== userId || route.origin !== CONTROL_UI_ORIGIN) {
    throw new Error("Control UI requires the initialized owner and allowed origin");
  }
  return route;
}

async function fetchControlUi({ path, authorization, method = "GET" }, { port = 18789 } = {}) {
  const route = classifyControlUiPath(path);
  if (!route) throw new Error("Unsupported Control UI path");
  if (method !== "GET" && method !== "HEAD") throw new Error("Unsupported Control UI method");
  if (authorization !== undefined && (typeof authorization !== "string" ||
      authorization.length > 4096 || /[\r\n]/.test(authorization))) {
    throw new Error("Invalid HTTP authorization");
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: {
        ...(route.spa ? { Accept: "text/html" } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error("Control UI asset exceeds limit"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: Object.fromEntries(["content-type", "content-security-policy", "x-content-type-options",
          "content-length", "retry-after", "etag", "last-modified", "allow"]
          .filter((name) => typeof res.headers[name] === "string")
          .map((name) => [name, res.headers[name]])),
        body: Buffer.concat(chunks).toString("base64"),
      }));
    });
    req.setTimeout(30000, () => req.destroy(new Error("Control UI fetch timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function runDeviceCommand({ command, requestId }, {
  env = process.env, run = promisify(execFile),
} = {}) {
  if (command !== "list" && command !== "approve") throw new Error("Unsupported device command");
  if (command === "approve" && (typeof requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId))) {
    throw new Error("Explicit pairing requestId required");
  }
  const args = ["devices", command, ...(command === "approve" ? [requestId] : []), "--json"];
  const { stdout } = await run("openclaw", args, { env, timeout: 60000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

function proxyControlUi(client, route, options) {
  // AgentCore can lose unsolicited frames sent before its forwarding stream
  // is ready. Wait for the authenticated relay's kickoff before opening the
  // gateway, so its real challenge reaches the browser without alteration.
  const timer = setTimeout(() => client.close(1008, "Control UI startup required"), 10000);
  client.once("close", () => clearTimeout(timer));
  client.once("error", () => { clearTimeout(timer); client.terminate(); });
  client.once("message", (data, binary) => {
    clearTimeout(timer);
    if (binary || data.toString() !== CONTROL_UI_START) {
      client.close(1008, "Invalid Control UI startup");
      return;
    }
    connectControlUiGateway(client, route, options);
  });
}

function connectControlUiGateway(client, { origin }, { port = 18789 } = {}) {
  const upstream = new WebSocket(`ws://127.0.0.1:${port}/`, {
    origin, maxPayload: MAX_BYTES, handshakeTimeout: 10000,
    // This authenticated tunnel is remote, not a direct local browser.
    // Overwrite attribution so OpenClaw cannot silently pair the browser.
    headers: { "X-Forwarded-For": "192.0.2.1", "X-Forwarded-Proto": "http" },
  });
  const pending = [];
  let pendingSize = 0;
  const send = (target, data, binary) => {
    if (target.readyState !== WebSocket.OPEN) return;
    if (target.bufferedAmount + data.length > MAX_BYTES) {
      client.close(1009, "Control UI backpressure limit");
      upstream.close(1009, "Control UI backpressure limit");
      return;
    }
    target.send(data, { binary });
  };
  client.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      pendingSize += data.length;
      if (pendingSize > MAX_BYTES) {
        client.close(1009, "Control UI payload limit");
        upstream.terminate();
      } else pending.push([data, binary]);
    } else send(upstream, data, binary);
  });
  upstream.on("open", () => {
    if (client.readyState !== WebSocket.OPEN) return upstream.close();
    for (const [data, binary] of pending) send(upstream, data, binary);
    pending.length = 0;
  });
  upstream.on("message", (data, binary) => send(client, data, binary));
  const closePeer = (peer, code, reason) => {
    if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
    else if (peer.readyState === WebSocket.OPEN) peer.close(
      code === 1005 || code === 1006 || code === 1015 ? 1011 : code, reason,
    );
  };
  upstream.on("close", (code, reason) => closePeer(client, code, reason));
  client.on("close", (code, reason) => closePeer(upstream, code, reason));
  upstream.on("error", () => closePeer(client, 1011, "Internal gateway unavailable"));
  client.on("error", () => closePeer(upstream, 1011, "Local relay disconnected"));
  return upstream;
}

module.exports = {
  CONTROL_UI_HEADER, CONTROL_UI_ORIGIN, CONTROL_UI_START, controlUiConfig, parseControlUiRoute,
  fetchControlUi, classifyControlUiPath, runDeviceCommand, proxyControlUi,
};
