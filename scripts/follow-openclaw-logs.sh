#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${OPENCLAW_PYTHON:-$PROJECT_DIR/.venv/bin/python}"
INTERVAL="${OPENCLAW_LOG_INTERVAL_SECONDS:-5}"

if [ "$#" -eq 0 ] || [ "${1:-}" = "--help" ]; then
    cat <<'EOF'
Usage: bash scripts/follow-openclaw-logs.sh --env dev [--actor-id telegram:YOUR_USER_ID]

Poll native OpenClaw logs every 5 seconds. Press Ctrl+C to stop.
Recent lines repeat between polls. Output may contain private conversation data.
Loads the selected env file; actor defaults to its first E2E_TELEGRAM_USER_ID.
Pass debug-openclaw.py options except --output and --check-mcp.
Overrides: OPENCLAW_PYTHON, OPENCLAW_LOG_INTERVAL_SECONDS (positive integer).
EOF
    exit 0
fi

ENV_NAME=""
HAS_ACTOR=0
ARGS=("$@")
for ((index=0; index<${#ARGS[@]}; index++)); do
    case "${ARGS[index]}" in
        --env)
            ENV_NAME="${ARGS[index+1]:-}"
            ;;
        --env=*)
            ENV_NAME="${ARGS[index]#*=}"
            ;;
        --actor-id|--actor-id=*)
            HAS_ACTOR=1
            ;;
    esac
done
if [ "$ENV_NAME" != "dev" ] && [ "$ENV_NAME" != "prod" ]; then
    echo "ERROR: specify --env dev or --env prod." >&2
    exit 1
fi
source "$PROJECT_DIR/scripts/lib/openclaw-env.sh"
load_project_env "$PROJECT_DIR" "$ENV_NAME"
apply_named_environment "$ENV_NAME"
if [ "$HAS_ACTOR" -eq 0 ]; then
    USER_ID="${E2E_TELEGRAM_USER_ID:-}"
    USER_ID="${USER_ID%%,*}"
    USER_ID="${USER_ID//[[:space:]]/}"
    if ! [[ "$USER_ID" =~ ^[0-9]+$ ]]; then
        echo "ERROR: set E2E_TELEGRAM_USER_ID in the selected env file or pass --actor-id." >&2
        exit 1
    fi
    ARGS+=(--actor-id "telegram:$USER_ID")
fi

if ! [[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: OPENCLAW_LOG_INTERVAL_SECONDS must be a positive integer." >&2
    exit 1
fi
if [ ! -x "$PYTHON" ]; then
    echo "ERROR: Python not found at $PYTHON; set OPENCLAW_PYTHON." >&2
    exit 1
fi
command -v jq >/dev/null || { echo "ERROR: jq is required." >&2; exit 1; }
for arg in "$@"; do
    case "$arg" in
        --output|--output=*|--check-mcp)
            echo "ERROR: $arg is not supported by the log follower." >&2
            exit 1
            ;;
    esac
done

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-follow.XXXXXXXX")"
LOG_FILE="$TEMP_DIR/logs.json"
cleanup() {
    rm -f -- "$LOG_FILE"
    rmdir -- "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while true; do
    "$PYTHON" "$PROJECT_DIR/scripts/debug-openclaw.py" --limit 100 "${ARGS[@]}" --output "$LOG_FILE"
    jq -r '.nativeLogs' "$LOG_FILE" |
        jq -r 'select(.type == "log") | [.time, .level, .message] | @tsv'
    rm -f -- "$LOG_FILE"
    sleep "$INTERVAL"
done
