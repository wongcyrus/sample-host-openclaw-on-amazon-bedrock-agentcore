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
| E2E lifecycle test timed out despite Telegram delivery | The existing log matcher recognizes Router sends, not contract-streamed delivery. Correlated Router logs with contract `Telegram streaming finalized` events and confirmed actual delivery. The old matcher remains a known test limitation. |

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

Pre-upgrade runtime configuration, CloudFormation template, and workspace copies
were retained privately for rollback. Workspace copies are in the dev user-files
bucket under `_deployment-rollbacks/`, including a final pre-migration copy.
Retain both the old image **and pre-migration state**: the old runtime cannot be
assumed to understand migrated schemas or new S3 manifests. A runtime image
rollback alone is insufficient after state migration. Stop current sessions
before changing runtime/state, and verify the next session uses the intended
image and a compatible restored workspace.
