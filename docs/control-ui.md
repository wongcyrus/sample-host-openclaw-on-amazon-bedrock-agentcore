# Dev OpenClaw Control UI

The real **OpenClaw 2026.9.7 bundled UI** is available through a local operator
relay. It uses the existing Telegram user's dev identity and **existing session
ID**, not a new dashboard user. Production continues to disable the Control UI.

## Start locally

```bash
.venv/bin/pip install -r scripts/requirements-control-ui.txt
./scripts/openclaw-control-ui.sh
```

The wrapper loads `.env.dev` using the deployment environment helper. Its default
actor uses the first `TELEGRAM_ADMIN_USER_ID` (comma-separated admins are supported);
for another **already registered**
dev actor, supply `--actor-id telegram:123456789` on every command. There must be
a `CHANNEL#…/PROFILE` and `USER#…/SESSION` entry in `openclaw-identity-dev`.
The runtime ARN/endpoint come from `OpenClawAgentCore-dev` outputs. Missing
identity/session or a non-dev runtime fails closed.

Open the private login URL printed in the terminal. The UI lives at
**http://127.0.0.1:18795/**. Do not substitute `localhost`, change the port, or
expose the listener over the network. The login URL grants local access for this
relay process; keep it private. An HTTP-only, SameSite=Strict cookie protects
subsequent relay requests. Host and browser Origin are checked exactly.
Before HTML loads and WebSocket connections, the relay checks the existing
session and warms it only when needed, allowing recovery after normal runtime
termination. Concurrent checks share one operation and successful checks are
cached for ten seconds. AWS connection/read timeouts are bounded; transient
readiness failures retry for up to four minutes. A browser request waits at most
30 seconds for readiness before showing an explicit HTTP 503 with reload
instructions, while the shared initialization check continues. The listener
starts immediately rather than blocking behind warmup. Device approval is
**never automatically retried**, even after a timeout.
It never changes the session ID, stops a busy session, or approves devices
without an explicit command.

AWS credentials and SigV4 headers remain in the Python process. The browser
receives the gateway token through a localhost URL **fragment**, never an AWS
credential or presigned AWS URL. OpenClaw consumes that fragment; access logging
is disabled and responses are `no-store`. Treat the browser profile and gateway
token as operator credentials. Native OpenClaw consumes the token fragment and
does not retain it for an unpaired browser: simply reloading the original relay
page previously produced `AUTH_TOKEN_MISSING`. Each cookie-authenticated
top-level navigation now receives a fresh fragment through a short-lived,
single-use navigation redirect. SPA paths and supported native query state are
retained, including `/chat/main`. A separate cookie-protected redirect document
preserves the incoming browser fragment (HTTP cannot read fragments), sets the
gateway token, and discards alternate gateway/password/bootstrap-auth overrides.
Its inline script has a per-response CSP nonce; the bundled UI is not rewritten.
Service-worker subresource fetches receive native responses without navigation
redirects. Navigation nonces are never forwarded to the gateway.
Native HTML, scripts, device identity, signatures and WebSocket connect frames
remain untouched. Runtime-config and native image GET/HEAD reads forward gateway
bearer auth after relay cookie authorization. This does
not skip native device pairing.

## Explicit browser device pairing

First connection must show **Approve this browser** (pairing required). The browser generates its own
device key and signs the gateway challenge; the relay does not rewrite connect
frames or create a substitute browser identity.

Keep the browser open, then inspect requests from another terminal:

```bash
./scripts/openclaw-control-ui.sh --devices
# Review device ID, public key, client, role and requested scopes.
./scripts/openclaw-control-ui.sh --approve REQUEST_ID
```

These commands invoke the supported `openclaw devices list --json` and
`openclaw devices approve REQUEST_ID --json` **inside the same runtime session**,
with the gateway's environment. Approval is a deliberate operator action.
There is no `--latest`, blanket approval, automatic approval, device-auth
disable, wildcard origin, or unauthenticated approval endpoint. Browser device
tokens are redacted from terminal output. The UI retries automatically after
approval; **Check now** can retry immediately.

The CLI is the gateway-host approval path: installing OpenClaw on the operator's
machine and approving against its local state would target the wrong gateway.
If a request is superseded, list again and review the new request ID. Scope
upgrades also require review. Pairing state resides in the user's persisted
OpenClaw workspace; clearing browser storage generates a new browser identity.

## Transport and boundaries

1. The localhost relay fetches UI assets from the running internal gateway via
   IAM-authenticated `InvokeAgentRuntime` (`control_ui_http`, explicit GET/HEAD
   route allowlist). The UI is not copied, rebuilt, or substituted locally.
2. Browser WebSocket → localhost relay → SigV4-authenticated AgentCore runtime
   `/ws` → internal gateway `127.0.0.1:18789`. A narrowly allowlisted
   `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Control-UI` header selects raw proxy
   mode and carries only the session owner and exact allowed browser origin.
3. The runtime rejects raw UI routing unless dev-enabled, initialized and owned
   by the requested user. Header-free `/ws`, `dashboard_snapshot` and
   `dashboard_events` continue to use the original dashboard adapter.
   Before opening the internal gateway, it consumes a fixed relay startup frame.
   This prevents AgentCore stream setup from dropping the gateway's immediate
   challenge. It is not an OpenClaw connect frame or a substitute challenge.
4. The internal proxy overwrites forwarded attribution with `192.0.2.1`, a
   documentation-only marker, rather than falsely claiming a direct local
   browser. OpenClaw therefore requires **explicit remote device pairing**, not
   its default loopback auto-pairing. This marker is not an actual client IP.
5. Gateway auth remains `token`; only `http://127.0.0.1:18795` is an allowed UI
   origin. AWS IAM access to the dev runtime and secret is required to start the
   operator relay. There are no new public ingress routes or IAM grants.

The shared route manifest permits native SPA documents, static assets and
runtime-config aliases, plus exact agent/user avatars, workspace/channel icons,
catalog/link/plugin/activity icons and four-component plugin theme-art reads.
SPA requests advertise HTML so the native gateway serves its own fallback
document. Only known per-route query parameters are forwarded; unknown local
queries (including query-string auth and relay nonces) are stripped. Encoded
session IDs are retained. HEAD is forwarded as HEAD, preserving native status,
MIME, content length and retry headers without a body. Missing images remain the
gateway's real 404; a not-yet-prepared workspace icon remains its 503 with
`Retry-After`, not a fabricated image or relay 502.

The relay supports those UI reads and the native gateway WebSocket protocol,
not arbitrary HTTP APIs, assistant-media tickets/downloads, browser uploads, OAuth
callbacks, gateway shell access, or public/shared dashboard hosting. Stop with
Ctrl+C; all relay connections close. The separate character dashboard is not
started by this tool.

## Deploy and validate

```bash
./scripts/deploy.sh --env dev --runtime-only
node --test bridge/control-ui.test.js bridge/dashboard-gateway.test.js
.venv/bin/python -m pytest tests/test_control_ui_relay.py -q
```

To check a real browser against the deployed gateway without approving it:

```bash
OPENCLAW_CONTROL_UI_LOGIN_URL='PRIVATE_LOCAL_LOGIN_URL' \
  node --test bridge/control-ui-live.test.js
```

This uses a fresh, isolated browser profile, the existing `playwright-core`
dependency and installed Google Chrome
(`OPENCLAW_UI_BROWSER_BINARY` can override the executable). It loads the real
bundle, captures the native challenge and signed `PAIRING_REQUIRED` response,
and leaves its test browser **unapproved**. Private verification artifacts and
the browser profile go under ignored `.bedrock_agentcore/control-ui-verification/`.
Its device ID is in `result.json`; do not confuse it with your interactive
browser's pending request. Without a login URL, this live test skips.
The automated test uses a fresh profile, blocks service workers for deterministic
request observation, and verifies a reload still reaches native pairing with the
**same browser device identity**, rather than losing its gateway token. Reused
profile navigation has also been verified live across three page loads with the
native service worker enabled. No synthetic browser was approved; authenticated
post-approval interactions have not been verified.

If approval reports that the reviewed request is no longer pending, do not
approve an unrelated or synthetic request. Reopen the relay's current private
login link in the **same real browser**, list requests again, and explicitly
review its new request ID. Restarting the local relay rotates its login URL and
cookie; old links/cookies no longer work. Runtime session expiration can also
require initialization before listing devices. A read timeout is not evidence
that approval succeeded: list device state before deciding whether to retry
the same reviewed ID.

Use the existing deployment runbook for backup, runtime version changes and
session refresh. Do not stop all sessions or deploy production to test this UI.
An older running container may need a **targeted, graceful** refresh after its
workspace backup and task status have been checked. Always re-resolve the
identity table after deployment.

Verification should load the HTML and hashed assets from the deployed runtime,
receive a native `connect.challenge`, and demonstrate a signed browser connect
returning `PAIRING_REQUIRED` with a pending request visible to `--devices`.
Do not approve a synthetic test browser or claim authenticated browser access
until an operator explicitly approves the real browser request.

### Protocol sources

- [AWS Runtime WebSocket contract and session routing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)
- [AWS custom header allowlist](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)
- [OpenClaw Control UI connection and pairing](https://docs.openclaw.ai/web/control-ui/connect-and-pair)
- [OpenClaw devices CLI](https://docs.openclaw.ai/cli/devices)

Implementation was checked against the exact `openclaw@2026.9.7` package:
`dist/control-ui` (including native `sw.js` and the core SPA route table),
`control-ui-resource-routes-*.mjs`, `control-ui-*.mjs`,
`server-control-ui-root-*.mjs`, `workspace-icon-http-*.mjs`,
`user-profiles-http-*.mjs`, `ingress-attribution-*.mjs`,
`node-connect-reconcile-*.mjs`, `devices-cli-*.mjs` and the bundled pairing docs.
