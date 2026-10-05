# OpenClaw 2026.9.7 upgrade

## Deployment record

On 2026-10-05, the upgrade was deployed to **dev in `us-east-1`** on branch
`feat/dashboard-bridge`. AgentCore runtime `openclaw_agent_dev-qSRs7y9pnv` and its
`DEFAULT` endpoint reached **runtime version 8**. This is the AgentCore deployment
version, not the OpenClaw package version.

Only `OpenClawAgentCore-dev` was updated. Existing networking was preserved and
Browser remained disabled. Production was not deployed. No Git commit or push
was made as part of deployment.

## Runtime and configuration changes

| Surface | Change |
|---|---|
| Container builds | Both Dockerfiles pin Node `24.16.0-bookworm-slim` and `openclaw@2026.9.7`; ARM64 remains required. |
| Agent configuration | Replace `agents.list` with ID-keyed `agents.entries`, set explicit ownership, and declare main system/heartbeat ownership and the active model-policy allowlist. |
| Existing behavior | Preserve per-user microVMs, scoped credentials, Lambda channel routing, AgentCore/LiteLLM providers, and configured main/sub-agent model choices. |
| Tool policy | Use the new `tools.exec.mode: "full"` setting instead of retired `security`/`ask` keys; update robot tool deny names to `view_image` and `x_search`. |
| Scheduling | Explicitly disable built-in OpenClaw cron; EventBridge remains the scheduler. |
| Gateway clients | Chat and dashboard bridges use loopback `gateway-client` / `backend` token authentication without a browser Origin header. Control UI stays disabled; obsolete authentication bypass settings are removed. |
| Protocol retry | Preserve actor identity, channel, and token when retrying the server-advertised protocol version. |
| Baked-in skills | Retain `jina-reader` and `telegram-compose`; remove ambiguous `deep-research-pro`, `transcript`, and `task-decomposer` references from both builds. Required skill-install failures now fail the build after retries. |

Built-in sub-agent delegation remains available. Removing a skill from the image
does **not** uninstall copies previously installed into a user's restored
workspace. A larger installed-skill count therefore does not indicate that the
removed skills are still baked into the image.

No EFS/shared filesystem architecture or PostgreSQL backend was introduced.
SQLite remains local to each user's microVM.

## Persistence and migration changes

`bridge/workspace-snapshot.js` creates consistent online backups of each SQLite
database using **Node's SQLite engine**, the same engine used by OpenClaw. It
checks integrity and omits live WAL/SHM/journal sidecars. SQLite databases are
exempt from the ordinary S3 backup 10 MB file limit.

`bridge/workspace-sync.js` uploads immutable generations under
`{namespace}/.openclaw-snapshots/{generation}/`. It publishes `latest.json` only
after all included files upload. The manifest contains sizes and SHA-256 hashes;
restore validates paths, sizes, and hashes before publishing the local workspace.
Legacy `{namespace}/.openclaw/` restore remains available when no manifest exists.
Overlapping saves are serialized.

Startup awaits restore and managed workspace preparation before starting the
gateway. When restored agent databases exist, the contract runs:

```bash
openclaw doctor --fix --non-interactive --no-workspace-suggestions
```

This runs offline with the gateway's scoped environment, a bounded timeout, and
explicit failure propagation. It migrates persisted media and older agent
schemas. The contract then reapplies its generated configuration and publishes
completed session-storage and S3 backups before launching the gateway.

Directory publication stages `.next` and retains `.previous`. When a filesystem
rejects renaming the workspace root with `EXDEV` or `EBUSY`, publication preserves
the root and uses a `.publish-pending` journal while replacing its contents.
Startup restores the previous copy after an interrupted replacement. Preparation
errors stop initialization instead of starting against partial state.

Shutdown stops periodic saves, waits for the gateway to exit, and then snapshots.
The previous completed backup is retained if shutdown cannot finish within the
platform grace period.

**Limits:** online consistency is per database, not one transaction across all
databases and files. Quiesce writers for cross-database deployment backups.
Immutable generations accumulate under bucket retention rules. Runtime updates
can clear session storage, so S3 recovery remains necessary.

## Failures found by live tracing

| Failure | Evidence and resolution |
|---|---|
| Snapshot integrity failed with `unknown function: octet_length()` | System Python SQLite was older than the runtime engine. Replaced Python snapshot/validation with Node SQLite and added a schema-function regression test. |
| Restored gateway exited with code 78 | Logs required offline media migration for agent schema v1. Added supported Doctor repair before gateway startup; verified v1-to-v24 migration and integrity using restored state. |
| Committed S3 restore failed with `EXDEV` | The AgentCore filesystem rejected whole-root directory rename. Added journaled in-place publication and interruption recovery; exercised a real mounted root and a new deployed microVM. |
| E2E lifecycle test timed out despite Telegram delivery | At the original upgrade, the log matcher recognized Router sends, not contract-streamed delivery. Batch 1 subsequently restored normal Router delivery; the matcher now also checks metadata-only Telegram delivery acknowledgements. |

The first attempts were rolled back to the previous image while migration was
debugged. The final deployment includes the fixes above; it is not the temporary
rollback image.

## Verified outcome and remaining scope

- Actual restored-user traffic completed Router Lambda -> AgentCore -> full
  OpenClaw gateway -> Telegram, without the warm-up footer.
- Gateway dashboard snapshots and events worked; runtime logs showed no startup,
  migration, authentication, or backup errors during the final channel check.
- A fresh post-chat periodic backup verified **21 file checksums and 4 SQLite
  databases**. A new microVM restored that committed generation, preserved gateway
  session identifiers, and answered through the full gateway.
- The real migrated user's committed backup also passed integrity checks for
  **10 database files**.
- **56 targeted regression tests** passed; JavaScript syntax and diff checks
  passed. Narrow security reviews of migration and publication found no
  vulnerabilities.

The bot previously reported scheduling/KMS and web-search issues. Those feature
claims were not independently reproduced or resolved by this upgrade. Do not
interpret successful chat as validation of scheduling, search, or every tool.
Full production/channel/delegation coverage remains a separate rollout gate.

## Operations and rollback

For a failure, correlate the Router Lambda request/session with the AgentCore
runtime log stream, then inspect contract initialization, offline migration,
gateway startup/authentication, model calls, and channel delivery. Health checks
and warm-up replies alone do not prove full gateway readiness.

For this dev rollout the log groups are:

```text
/openclaw/lambda/router-dev
/aws/bedrock-agentcore/runtimes/openclaw_agent_dev-qSRs7y9pnv-DEFAULT
```

The final deploy was scoped as follows after loading the dev environment and
activating the Python virtualenv:

```bash
cdk deploy OpenClawAgentCore-dev --exclusively \
  -c enable_browser=false \
  -c 'availability_zones=["us-east-1d","us-east-1b","us-east-1c"]' \
  --require-approval never
```

These AZ names preserve this account's existing dev layout; do not copy them to
another account without inspecting its deployed template and diff.

At deployment time, pre-upgrade runtime configuration, CloudFormation template,
and workspace copies were retained privately for rollback. The workspace copies
were under `_deployment-rollbacks/` in the dev user-files bucket. **The subsequent
authorized dev reset deleted those copies and all other dev user S3 versions;
state rollback to that deployment is no longer available.**
Retain both the old image **and pre-migration state**: the old runtime cannot be
assumed to understand migrated schemas or new S3 manifests. A runtime image
rollback alone is insufficient after state migration. Stop current sessions
before changing runtime/state, and verify the next session uses the intended
image and a compatible restored workspace.

## Selective upstream fixes: batch 1

The existing upgrade was committed as `2fead53`. Batch 1 was adapted from the
official AWS repository rather than merging its `main` branch: our OpenClaw
`2026.9.7` pin, generated agent configuration, dashboard/direct-agent routing,
gateway authentication, offline migration, and immutable SQLite backups remain
intact. Batch 1 and the live-discovered repairs below are now deployed to dev;
the final AgentCore runtime and `DEFAULT` endpoint are both **version 12**.
Production was not deployed. The batch changes remain uncommitted.

| Official change | Local adaptation |
|---|---|
| `b0c427f`, `100a21c`, `b2f4c3f` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#140, aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#131, aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#123) | Normal Telegram replies go through Router markdown-to-HTML formatting and UTF-16-safe splitting. Cron uses the same limit-aware delivery behavior. The contract maintains typing indicators but sends a chunked plain-text fallback only when the invocation caller disconnects. |
| `5d452ba` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#135) | Filter gateway chat events by run ownership, including yielded successors, so unrelated/sub-agent events cannot complete the wrong invocation. |
| `772ece1`, `608e19f` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#127, aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#136) | Buffer HTTP bytes and decode UTF-8 once, preserving CJK and emoji across network chunk boundaries. Contract and proxy share `read-body.js`; lightweight HTTP responses follow the same byte-buffering principle. |
| `e09cafb`, `e2e0769`, `ca7cfc2` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#129, aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#130, aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#132) | Preserve API-key migration sources on failed reads/writes, reject corrupt native JSON instead of overwriting it, and use a seven-day Secrets Manager deletion recovery window. |
| `819ea5e` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#119) | Validate DNS addresses at the actual HTTP connection, including redirects and IPv4-mapped IPv6 addresses, rather than relying only on a preflight lookup. |
| `bbb0906` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#112) | Install CA certificates explicitly in both build stages and assert the runtime trust bundle exists in both Dockerfiles. |
| Selected `4a6bf6c` changes (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#117) | Forward guardrail ID/version into the proxy's explicit child-process environment; do not replace our storage implementation with the rest of this upstream patch. |
| `7ab44b5` (aws-samples/sample-host-openclaw-on-amazon-bedrock-agentcore#126) | Make Secrets Manager tests hermetic using SDK stubs, without requiring a configured AWS region or credentials. |

ClawHub runtime persistence and the skills dependency symlink were explicitly
excluded. This batch does not add or remove baked-in skills.

Final validation covered **316 combined bridge/storage/configuration tests** and
**68 Python formatting, delivery, and E2E-observation regression tests**.
The ARM64 CDK Dockerfile built successfully, and its resulting container contained
the CA bundle and both new helpers. OpenClaw `2026.9.7` itself accepted the generated
ordered-fallback configuration using `openclaw config validate`.

The final deployed targeted suite passed **8 live tests**: health, webhook
acceptance/rejection, message lifecycle, three Telegram formatting checks, and
actual sub-agent completion. This is not the full 50-test E2E suite: Browser
remains disabled and skill-management tests were intentionally excluded.

### Live-discovered repairs and provider configuration

Router-only rich delivery exposed a table conversion bug: a first-column cell
already wrapped in `**bold**` was wrapped again, producing overlapping HTML tags.
Telegram rejected that HTML and used plain-text fallback. Router and Cron now
avoid the duplicate wrapper, with regression coverage for both bold syntaxes.
The final table E2E test requires Telegram to accept HTML without falling back.
The Router reports incomplete delivery as an error, not a success.

New delivery acknowledgements log **only format and length**, never per-chunk
message content. A targeted security review identified excess reply logging
in the initial implementation; that medium-severity finding was fixed, and
the follow-up review reported no remaining findings. The later pre-commit secret
review also identified the pre-existing response preview as a potential API-key
leak. The pending commit removes raw AgentCore response previews from Router
and Cron, the Telegram response preview, and the cron event payload log.
Telegram observations now log only length, warm-up status, and boolean
format-shape flags, plus delivery format/length. Synthetic credential-bearing
regressions check that replies still reach the caller without appearing in logs.

The log-based E2E harness uses those metadata fields for lifecycle, warm-up,
formatting, and delegation checks. Content-dependent tests now fail explicitly
when reply content is unavailable, rather than passing negative checks against an
empty string; they require a separate authenticated channel capture. This
pre-commit logging remediation has **not yet been deployed**, and does not remove
historical CloudWatch records. Runtime version 12 remains the previously verified
deployment described below.

Before committing, all 30 staged files were reviewed for credentials and checked
against configured dev secret values without printing those values. No configured
secret or private-key block was found, and `.env.dev` remained ignored and
excluded. The logging remediation passed **73 Python regressions**; the
**316 bridge regressions** also passed. The final staged security review reported
no findings. This does not certify or erase historical logs or unrelated runtime
logging outside the reviewed changes.

The user's LiteLLM provider has OpenAI and Gemini disabled. Dev previously
selected disabled `gpt-5.4-mini` for sub-agents, causing provider HTTP 502 errors.
The final main, managed-agent, and sub-agent configuration uses:

```text
kimi-k3 -> kimi-k2.5 -> minimax-m2.5 -> nova-2-lite
```

All four models passed direct provider canaries. Both authorization headers
(`Authorization` and `x-api-key`) are required by this API Gateway-backed provider;
omitting `x-api-key` caused the initial local canaries to return HTTP 403.
`LITELLM_FALLBACK_MODEL_IDS` is an optional JSON array of unique catalog IDs,
forwarded by CDK into OpenClaw's native model fallback objects. Disabled models
are absent from the dev catalog and model-policy allowlist.

The old delegation check used a Bedrock-proxy request counter, which LiteLLM
bypasses. Gateway session listings also did not expose the child runs used by
this deployment. The E2E check now deduplicates completed child-run IDs from the
latest microVM log stream initialized for the test user; it does not rely on
bot-reported success. A unique run marker forces fresh work rather than allowing
the model to summarize prior results. The final trace recorded five completed
child runs and confirmed the ready gateway uses `litellm/kimi-k3`.

**Remaining observations:** the final cold-start test window included one Router
invocation returning a runtime HTTP 502, although the subsequent full lifecycle
passed. Some LiteLLM `kimi-k2.5` child attempts still emitted
`Provider returned an incomplete or malformed tool call`; successful child
completions and parent synthesis were observed afterward. Passing the targeted
suite is not a claim that every provider attempt succeeded or that scheduling,
web search, images, or forced failover across every model was verified.

## Authorized fresh dev reset

After explicit approval to reset all dev user identities, files, and schedules,
the reset was confined to `us-east-1` dev resources. Production and infrastructure
were not changed. Router and cron Lambda concurrency was temporarily set to
zero during deletion and restored afterward.

The reset removed 10 identity/session/binding records, 26 Cognito users, and all
non-bootstrap S3 objects, historical versions, and delete markers, including
immutable workspace generations and deployment rollback copies. More than
600,000 S3 version entries were purged. The dev Scheduler group already contained
zero schedules. Recorded runtime sessions were already absent.

Shared `workspace-bootstrap/` objects and infrastructure/channel credentials
were preserved. Only the two configured Telegram operator allowlist entries were
recreated; user profiles and session pointers were not. The next registration
therefore creates a new identity and runtime session rather than reusing a
stopped session's storage or recovering an old workspace. The fresh workspace
still receives the deliberately preserved managed bootstrap.

The reset itself did not change the deployed image (then runtime version 8).
The subsequent batch-1 rollout reached version 12 and live testing created new
conversation state. Historical upgrade verification above describes the
pre-reset state, not retained old user data.

## Retained identity-table KMS permissions

The scheduling failure was traced to DynamoDB, not Scheduler encryption.
`list_schedules` queries the retained identity table, which still uses an older
customer-managed KMS key. The runtime execution role had access to the current
secrets key, but not that table's actual key, causing `kms:Decrypt` denials.

RouterStack already discovers the table's encryption key using `DescribeTable`.
It now passes that ARN to CronStack, which grants the runtime execution role and
cron Lambda `kms:Decrypt` and `kms:GenerateDataKey` on that exact key, restricted
by `kms:ViaService` to the regional DynamoDB service. New tables use the current
configured key. The fix does not replace the table or key, change the key policy,
or broaden the scoped STS session policy.

Both retained-key and new-key template regression cases passed, as did dev CDK
synthesis. IAM simulation allowed the new grant through DynamoDB and rejected
its use through Secrets Manager. The targeted security review found no issues.
These checks do not substitute for a live scheduling operation after deployment.

This KMS fix is not deployed. The scoped deployment diff also includes the
previously committed response-log privacy remediation (runtime image and
Router/cron Lambda code), so applying it is not an IAM-only rollout. There are
no table, key, or networking changes in that diff.
