#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/openclaw-env.sh"
load_project_env "$PROJECT_DIR" dev
apply_named_environment dev
exec "$PROJECT_DIR/.venv/bin/python" "$SCRIPT_DIR/openclaw-control-ui.py" "$@"
