#!/usr/bin/env bash
# Pull or push per-agent workspace files between local disk and the user S3 namespace.
#
# Usage:
#   ./scripts/sync-agent-workspace.sh --env dev pull --actor-id telegram:123456
#   ./scripts/sync-agent-workspace.sh --env dev push --actor-id telegram:123456 --local-dir ~/tmp/telegram_123456
#
# Local layout:
#   <root files>      main workspace files (<namespace>/<filename>)
#   <agent>/          per-agent workspace files (<namespace>/agents/<agent>/<filename>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_ENV_NAME="${OPENCLAW_ENV_NAME:-dev}"

COMMAND=""
ACTOR_ID=""
NAMESPACE=""
LOCAL_DIR=""
AGENTS_CSV=""
BUCKET_OVERRIDE=""
REGION=""
FORCE=0
DELETE_MISSING=0
MAIN_AGENT_ID="main"

usage() {
    cat <<'EOF'
Usage:
  ./scripts/sync-agent-workspace.sh [--env <name>] pull|push [options]

Target selection:
  If neither --actor-id nor --namespace is passed, the script uses
  TELEGRAM_ADMIN_USER_ID from the selected env file as telegram:<id>.
  --actor-id <channel:user_id>   Channel identity, for example telegram:123456
  --namespace <channel_user_id>  S3 namespace, for example telegram_123456

Options:
  --env <name>         Load .env.<name> (default: dev)
  --local-dir <path>   Local workspace directory
                       Default: ~/.openclaw-agent-workspaces/<namespace>
  --agents <csv>       Comma-separated agent list
                       Default: main,robot_1,robot_2,robot_3,robot_4,robot_5,robot_6
  --bucket <name>      Override S3 bucket name
  --region <region>    AWS region (default: from env or us-west-2)
  --force              Overwrite the local shared/agents/resolved trees on pull
  --delete-missing     On push, delete remote managed files that are missing locally
  -h, --help           Show this help text

Examples:
  ./scripts/sync-agent-workspace.sh pull
  ./scripts/sync-agent-workspace.sh push
  ./scripts/sync-agent-workspace.sh --env prod pull
  ./scripts/sync-agent-workspace.sh --env dev push --namespace telegram_123456 \
    --local-dir ~/tmp/telegram_123456
EOF
}

POSITIONAL_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        pull|push)
            COMMAND="$1"
            shift
            ;;
        --env)
            [ $# -lt 2 ] && { echo "ERROR: --env requires a value."; usage; exit 1; }
            OPENCLAW_ENV_NAME="$2"
            shift 2
            ;;
        --env=*)
            OPENCLAW_ENV_NAME="${1#*=}"
            shift
            ;;
        --actor-id)
            [ $# -lt 2 ] && { echo "ERROR: --actor-id requires a value."; usage; exit 1; }
            ACTOR_ID="$2"
            shift 2
            ;;
        --actor-id=*)
            ACTOR_ID="${1#*=}"
            shift
            ;;
        --namespace)
            [ $# -lt 2 ] && { echo "ERROR: --namespace requires a value."; usage; exit 1; }
            NAMESPACE="$2"
            shift 2
            ;;
        --namespace=*)
            NAMESPACE="${1#*=}"
            shift
            ;;
        --local-dir)
            [ $# -lt 2 ] && { echo "ERROR: --local-dir requires a value."; usage; exit 1; }
            LOCAL_DIR="$2"
            shift 2
            ;;
        --local-dir=*)
            LOCAL_DIR="${1#*=}"
            shift
            ;;
        --agents)
            [ $# -lt 2 ] && { echo "ERROR: --agents requires a value."; usage; exit 1; }
            AGENTS_CSV="$2"
            shift 2
            ;;
        --agents=*)
            AGENTS_CSV="${1#*=}"
            shift
            ;;
        --bucket)
            [ $# -lt 2 ] && { echo "ERROR: --bucket requires a value."; usage; exit 1; }
            BUCKET_OVERRIDE="$2"
            shift 2
            ;;
        --bucket=*)
            BUCKET_OVERRIDE="${1#*=}"
            shift
            ;;
        --region)
            [ $# -lt 2 ] && { echo "ERROR: --region requires a value."; usage; exit 1; }
            REGION="$2"
            shift 2
            ;;
        --region=*)
            REGION="${1#*=}"
            shift
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --delete-missing)
            DELETE_MISSING=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

if [ -z "$COMMAND" ] && [ "${#POSITIONAL_ARGS[@]}" -gt 0 ]; then
    COMMAND="${POSITIONAL_ARGS[0]}"
fi

if [ "$COMMAND" != "pull" ] && [ "$COMMAND" != "push" ]; then
    echo "ERROR: choose pull or push."
    usage
    exit 1
fi

# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/openclaw-env.sh"
load_project_env "$PROJECT_DIR" "$OPENCLAW_ENV_NAME"
apply_named_environment "$OPENCLAW_ENV_NAME"

REGION="${REGION:-${CDK_DEFAULT_REGION:-${AWS_REGION:-us-west-2}}}"
PROFILE_ARGS=()
if [ -n "${AWS_PROFILE:-}" ]; then
    PROFILE_ARGS+=(--profile "$AWS_PROFILE")
fi

if [ -z "$ACTOR_ID" ] && [ -z "$NAMESPACE" ] && [ -n "${TELEGRAM_ADMIN_USER_ID:-}" ]; then
    if [[ ! "${TELEGRAM_ADMIN_USER_ID}" =~ ^[0-9]+$ ]]; then
        echo "ERROR: TELEGRAM_ADMIN_USER_ID must be numeric. Got: ${TELEGRAM_ADMIN_USER_ID}"
        exit 1
    fi
    ACTOR_ID="telegram:${TELEGRAM_ADMIN_USER_ID}"
fi

if [ -z "$NAMESPACE" ] && [ -n "$ACTOR_ID" ]; then
    NAMESPACE="${ACTOR_ID//:/_}"
fi

if [ -z "$NAMESPACE" ]; then
    echo "ERROR: pass --actor-id or --namespace, or set TELEGRAM_ADMIN_USER_ID in the selected env file."
    usage
    exit 1
fi

if [[ ! "$NAMESPACE" =~ ^[A-Za-z][A-Za-z0-9_-]{1,64}$ ]]; then
    echo "ERROR: invalid namespace: $NAMESPACE"
    exit 1
fi

if [ -z "$LOCAL_DIR" ]; then
    LOCAL_DIR="${HOME}/.openclaw-agent-workspaces/${NAMESPACE}"
fi

WORKSPACE_LAYOUT_FILE="$LOCAL_DIR/.workspace-layout.txt"
WORKSPACE_MANIFEST_FILE="$LOCAL_DIR/.workspace-manifest.json"
WORKSPACE_SOURCES_FILE="$LOCAL_DIR/.workspace-sources.tsv"

resolve_bucket() {
    if [ -n "$BUCKET_OVERRIDE" ]; then
        printf '%s\n' "$BUCKET_OVERRIDE"
        return 0
    fi
    if [ -n "${S3_USER_FILES_BUCKET:-}" ]; then
        printf '%s\n' "$S3_USER_FILES_BUCKET"
        return 0
    fi

    local stack_name
    stack_name="$(with_suffix "OpenClawAgentCore")"
    aws cloudformation describe-stacks \
        --stack-name "$stack_name" \
        --region "$REGION" \
        "${PROFILE_ARGS[@]}" \
        --query "Stacks[0].Outputs[?OutputKey=='UserFilesBucketName'].OutputValue | [0]" \
        --output text
}

workspace_filenames() {
    node - "$PROJECT_DIR" <<'NODE'
const projectDir = process.argv[2];
const { WORKSPACE_FILES } = require(projectDir + "/bridge/workspace-files.js");
for (const item of WORKSPACE_FILES) {
  console.log(item.filename);
}
NODE
}

default_agent_ids() {
    node - "$PROJECT_DIR" <<'NODE'
const projectDir = process.argv[2];
const { ROBOT_AGENT_IDS } = require(projectDir + "/bridge/workspace-files.js");
for (const agentId of ROBOT_AGENT_IDS) {
  console.log(agentId);
}
NODE
}

uses_root_fallback() {
    local filename="$1"
    case "$filename" in
        USER.md)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

resolved_agent_ids() {
    if [ -n "$AGENTS_CSV" ]; then
        python3 - "$AGENTS_CSV" <<'PY'
import re
import sys

raw = sys.argv[1]
for item in re.split(r"[\s,]+", raw.strip()):
    value = item.strip()
    if value:
        print(value)
PY
    else
        default_agent_ids
    fi
}

default_file_base64() {
    local filename="$1"
    local agent_id="$2"
    local humanoid_enabled="$3"
    local browser_enabled="$4"
    node - "$PROJECT_DIR" "$filename" "$agent_id" "$humanoid_enabled" "$browser_enabled" <<'NODE'
const projectDir = process.argv[2];
const filename = process.argv[3];
const agentId = process.argv[4];
const humanoidEnabled = process.argv[5] === "true";
const browserEnabled = process.argv[6] === "true";
const { getWorkspaceDefaults } = require(projectDir + "/bridge/workspace-files.js");
const defaults = getWorkspaceDefaults({ humanoidEnabled, browserEnabled }, agentId);
const value = defaults[filename] || "";
process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
NODE
}

write_default_file() {
    local filename="$1"
    local target="$2"
    local agent_id="$3"
    local humanoid_enabled="$4"
    local browser_enabled="$5"
    local encoded
    encoded="$(default_file_base64 "$filename" "$agent_id" "$humanoid_enabled" "$browser_enabled")"
    python3 - "$target" "$encoded" <<'PY'
import base64
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(base64.b64decode(sys.argv[2]))
PY
}

write_layout_file() {
    local agents_csv="$1"
    cat > "$WORKSPACE_LAYOUT_FILE" <<EOF
Local agent workspace sync
==========================

Namespace: $NAMESPACE
Bucket: $BUCKET
Region: $REGION
Agents: $agents_csv

Edit these paths:
  <root>/<FILE>      main workspace files
  <root>/<AGENT>/    per-agent workspace folders

Sync commands:
  Pull again:
    ./scripts/sync-agent-workspace.sh ${OPENCLAW_ENV_NAME:+--env $OPENCLAW_ENV_NAME }pull --namespace $NAMESPACE --local-dir "$LOCAL_DIR"${AGENTS_CSV:+ --agents "$AGENTS_CSV"}

  Push local edits:
    ./scripts/sync-agent-workspace.sh ${OPENCLAW_ENV_NAME:+--env $OPENCLAW_ENV_NAME }push --namespace $NAMESPACE --local-dir "$LOCAL_DIR"${AGENTS_CSV:+ --agents "$AGENTS_CSV"}

Notes:
  - root files map to s3://$BUCKET/$NAMESPACE/<FILE>
  - agent folders map to s3://$BUCKET/$NAMESPACE/agents/<AGENT>/<FILE>
  - push uploads the current root files and agent folders directly.
  - push does not delete remote files unless you add --delete-missing.
  - active sessions do not reload these files instantly; recycle or stop the session to see changes immediately.
EOF
}

write_manifest_file() {
    python3 - "$WORKSPACE_SOURCES_FILE" "$WORKSPACE_MANIFEST_FILE" "$BUCKET" "$NAMESPACE" "$LOCAL_DIR" "$REGION" <<'PY'
import json
import pathlib
import sys

sources_file = pathlib.Path(sys.argv[1])
manifest_file = pathlib.Path(sys.argv[2])
bucket = sys.argv[3]
namespace = sys.argv[4]
local_dir = sys.argv[5]
region = sys.argv[6]

entries = []
for line in sources_file.read_text(encoding="utf-8").splitlines():
    agent, filename, source, relative_path = line.split("\t")
    entries.append({
        "agentId": agent,
        "filename": filename,
        "source": source,
        "localPath": relative_path,
    })

manifest = {
    "bucket": bucket,
    "namespace": namespace,
    "region": region,
    "localDir": local_dir,
    "entries": entries,
}
manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
}

pull_target_ready() {
    if [ "$FORCE" -eq 1 ]; then
        rm -rf \
            "$LOCAL_DIR" \
            "$WORKSPACE_LAYOUT_FILE" \
            "$WORKSPACE_MANIFEST_FILE" \
            "$WORKSPACE_SOURCES_FILE"
    else
        mkdir -p "$LOCAL_DIR"
        rm -rf \
            "$LOCAL_DIR/shared" \
            "$LOCAL_DIR/agents" \
            "$LOCAL_DIR/resolved"
    fi
}

cmd_pull() {
    pull_target_ready

    local browser_enabled="false"
    if [ -n "${BROWSER_IDENTIFIER:-}" ]; then
        browser_enabled="true"
    fi

    mapfile -t workspace_files < <(workspace_filenames)
    mapfile -t agent_ids < <(resolved_agent_ids)
    local humanoid_enabled="false"
    if [ "${#agent_ids[@]}" -gt 1 ]; then
        humanoid_enabled="true"
    fi

    mkdir -p "$LOCAL_DIR"
    : > "$WORKSPACE_SOURCES_FILE"

    local main_count=0
    local agent_count=0
    local local_path=""
    local main_key=""
    local agent_path=""
    local agent_key=""
    local source=""

    for filename in "${workspace_files[@]}"; do
        local_path="$LOCAL_DIR/$filename"
        main_key="${NAMESPACE}/${filename}"
        if aws s3 cp "s3://${BUCKET}/${main_key}" "$local_path" \
            --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors >/dev/null 2>&1; then
            main_count=$((main_count + 1))
            source="$main_key"
        else
            write_default_file "$filename" "$local_path" "$MAIN_AGENT_ID" "$humanoid_enabled" "$browser_enabled"
            source="default"
        fi
        printf '%s\t%s\t%s\t%s\n' \
            "$MAIN_AGENT_ID" \
            "$filename" \
            "$source" \
            "$filename" >> "$WORKSPACE_SOURCES_FILE"

        for agent_id in "${agent_ids[@]}"; do
            mkdir -p "$LOCAL_DIR/$agent_id"
            agent_path="$LOCAL_DIR/$agent_id/$filename"
            agent_key="${NAMESPACE}/agents/${agent_id}/${filename}"

            if aws s3 cp "s3://${BUCKET}/${agent_key}" "$agent_path" \
                --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors >/dev/null 2>&1; then
                agent_count=$((agent_count + 1))
                source="$agent_key"
            else
                if uses_root_fallback "$filename" && [ -f "$local_path" ]; then
                    cp "$local_path" "$agent_path"
                    source="$main_key"
                else
                    write_default_file "$filename" "$agent_path" "$agent_id" "$humanoid_enabled" "$browser_enabled"
                    source="default"
                fi
            fi

            printf '%s\t%s\t%s\t%s\n' \
                "$agent_id" \
                "$filename" \
                "$source" \
                "${agent_id}/${filename}" >> "$WORKSPACE_SOURCES_FILE"
        done
    done

    write_layout_file "$(IFS=,; echo "${agent_ids[*]}")"
    write_manifest_file

    echo "Pulled workspace files for $NAMESPACE"
    echo "  Bucket:    $BUCKET"
    echo "  Local dir: $LOCAL_DIR"
    echo "  Main workspace files downloaded: $main_count"
    echo "  Agent-specific files downloaded: $agent_count"
}

cmd_push() {
    if [ ! -d "$LOCAL_DIR" ]; then
        echo "ERROR: local directory does not exist: $LOCAL_DIR"
        exit 1
    fi

    mapfile -t workspace_files < <(workspace_filenames)
    mapfile -t agent_ids < <(resolved_agent_ids)

    local uploaded=0
    local deleted=0
    local local_file=""
    local remote_key=""

    for filename in "${workspace_files[@]}"; do
        local_file="$LOCAL_DIR/$filename"
        remote_key="${NAMESPACE}/${filename}"
        if [ -f "$local_file" ]; then
            aws s3 cp "$local_file" "s3://${BUCKET}/${remote_key}" \
                --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors
            uploaded=$((uploaded + 1))
        elif [ "$DELETE_MISSING" -eq 1 ]; then
            aws s3 rm "s3://${BUCKET}/${remote_key}" \
                --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors >/dev/null
            deleted=$((deleted + 1))
        fi

        for agent_id in "${agent_ids[@]}"; do
            local_file="$LOCAL_DIR/$agent_id/$filename"
            remote_key="${NAMESPACE}/agents/${agent_id}/${filename}"
            if [ -f "$local_file" ]; then
                aws s3 cp "$local_file" "s3://${BUCKET}/${remote_key}" \
                    --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors
                uploaded=$((uploaded + 1))
            elif [ "$DELETE_MISSING" -eq 1 ]; then
                aws s3 rm "s3://${BUCKET}/${remote_key}" \
                    --region "$REGION" "${PROFILE_ARGS[@]}" --only-show-errors >/dev/null
                deleted=$((deleted + 1))
            fi
        done
    done

    echo "Pushed workspace files for $NAMESPACE"
    echo "  Bucket:    $BUCKET"
    echo "  Local dir: $LOCAL_DIR"
    echo "  Uploaded:  $uploaded"
    echo "  Deleted:   $deleted"
    echo "  Note: recycle or stop the active AgentCore session to see changes immediately."
}

BUCKET="$(resolve_bucket)"
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ] || [ "$BUCKET" = "null" ]; then
    echo "ERROR: failed to resolve the user-files bucket."
    exit 1
fi

case "$COMMAND" in
    pull)
        cmd_pull
        ;;
    push)
        cmd_push
        ;;
esac
