# Native OpenClaw diagnostics on AgentCore

Use `scripts/debug-openclaw.py` to retrieve OpenClaw's native rolling-file logs,
not a model-generated summary. It invokes a fixed `diagnostics` contract action
through the IAM-authenticated AgentCore data plane. It does not send a chat
message, spawn agents, or execute robot actions.

```bash
source .venv/bin/activate
python scripts/debug-openclaw.py \
  --env dev --region us-east-1 \
  --actor-id telegram:YOUR_USER_ID \
  --limit 1000 \
  --check-mcp \
  --output /tmp/openclaw-diagnostics.json
```

The caller needs CloudFormation stack-output read access, identity-table
`GetItem`, and `bedrock-agentcore:InvokeAgentRuntime`. Target an existing,
initialized user session; the script resolves its internal user and session
IDs from DynamoDB rather than creating a diagnostic identity. The contract
requires the initialized session owner and a ready OpenClaw process.

The JSON file includes:

- `nativeLogs`: raw JSON-lines stdout from `openclaw logs`, using the gateway's
  native `logs.tail` RPC/file-log source. Its metadata identifies the source file.
- `skills`: enabled state, configured endpoint/auth mode, and whether each MCP
  skill endpoint matches the container's current runtime setting.
- `expectedMcpUrl`, `extraDirs`, build version, and container uptime.
- `mcpConnection`, when requested: actual HTTP status and tool names from the
  humanoid launcher's IAM-signed `tools/list`. It never calls `tools/call`.

The file is created with permissions `0600`, refuses to overwrite an existing
file, and is not printed to the terminal. Native logs can contain conversation
text, endpoints, and tool arguments: keep the artifact private, never commit
it, and delete the local file after investigating. The maximum line count is
2000 and the native log read is bounded to 500000 bytes; select an earlier
CloudWatch window separately when the native rolling tail does not cover the
request.

For example, inspect native log records locally:

```bash
jq -r '.nativeLogs' /tmp/openclaw-diagnostics.json |
  jq -r 'select(.type == "log") | [.time, .level, .message] | @tsv'
```

To follow native logs by polling:

```bash
bash scripts/follow-openclaw-logs.sh \
  --env dev
```

The follower loads `.env.dev` or `.env.prod` using the shared environment loader.
It defaults to the first `E2E_TELEGRAM_USER_ID` in that file and its configured
region. Pass `--actor-id telegram:YOUR_USER_ID` or `--region` to override.

Press Ctrl+C to stop. This polls every five seconds, displays the latest 100
records, and repeats overlapping lines; it is not a continuous gateway stream.
Temporary private files are cleaned up on exit. Collection errors stop the
follower rather than silently displaying old logs. It needs `jq` and uses the
repository virtualenv Python; override `OPENCLAW_PYTHON` or
`OPENCLAW_LOG_INTERVAL_SECONDS` if needed. It never runs MCP connection checks
or robot actions. Keep terminal output private. Native timestamps are UTC.

## Interpreting robot failures

`humanoid` and `digital_human` are installed skills, not automatically registered
native MCP tools. Robot agents launch `/skills/humanoid/run.sh`; the script then
calls the MCP gateway. An empty native MCP tool search does not establish that
the skills are absent.

`--list-actions` only prints a local action catalog. For connectivity, use
`--check-mcp` above or `/skills/humanoid/run.sh --check-connection` inside the
runtime. HTTP 403/AccessDenied suggests authorization; HTTP 404 on an old
gateway suggests configuration; model HTTP 502 errors precede skill execution
and are provider failures. Listing gateway tools does not prove a physical
robot action succeeded.

Check actual `tool=exec`, `sessions_spawn`, and tool results, not assistant
phrases such as "spawning robot_1". A completed chat run that only lists agents
has not dispatched robot work.

In the dynamic tool catalog, use `tool_search` to discover delegation tools,
`tool_describe` to inspect their schema, then `tool_call` with the returned ID
and complete arguments. `Unknown tool id` is a local catalog lookup failure,
not a gateway IAM denial. A discovered `sessions_spawn` still requires `task`;
`sessions_send` requires `message`. Native logs showed both wrong-ID and
missing-argument failures, so repeating a guessed call is not a repair.

Queued turns can also wait behind a long-running request. Look for
`lane wait exceeded` and `context overflow detected`; neither establishes a
skill invocation. Conversation compaction and model retries can delay replies
even when the MCP endpoint is healthy.

MCP settings are forwarded through the OpenClaw subprocess's safe environment
allowlist without forwarding container credentials. The launchers prefer
current `HUMANOID_MCP_*` settings over older per-skill `MCP_*` settings; explicit
CLI flags still override both. Deployment reads the selected `.env*` MCP
settings before legacy CDK context and scopes gateway IAM to the exact ARN.

After runtime changes, stop the affected session and rotate its DynamoDB
session pointer before testing a fresh microVM. Preserve the user identity and
S3 workspace. A control-plane version update alone does not establish what an
already-running container has loaded.

OpenClaw 2026.9.7 also checks the generated config against `openclaw.json.last-good`.
If the backup has `meta` but the new generated config does not, it can classify
the new config as damaged (`missing-meta-vs-last-good`) and restore the old
endpoint. The contract writes a schema-valid `meta: {}` object on every generated
config, preventing that false recovery without deleting user workspace data or
backups. The regression was also exercised against the real 2026.9.7 CLI with
an older last-good config; do not add unsupported metadata fields.

The helper requires a runtime image containing the `diagnostics` action. Older
images return an explicit unsupported/not-ready error rather than falling back
to model-mediated log collection. The existing `test-dashboard-bridge.py` and
`quick-dashboard-bridge.sh` scripts test dashboard snapshots, not native logs.

## Verified dev repair

Dev runtime version **17** was verified using this script against a fresh user
session. Both `humanoid` and `digital_human` were enabled and their saved config
URLs matched the deployed runtime URL. The actual humanoid launcher returned
HTTP **200** and **30** tools using scoped IAM credentials. Native logs were
downloaded directly, without an LLM or temporary S3 upload. The Telegram message
lifecycle also passed. No physical robot actions were invoked; tool listing is
not proof of successful robot movement or model delegation.

A separate provider canary still returned HTTP **502** for Kimi K3, while
Kimi K2.5, MiniMax M2.5, and Nova 2 Lite returned HTTP **200**. The selected model
order was preserved. The MCP/config repair does not resolve that provider outage
or guarantee that a model will supply valid delegation arguments.
