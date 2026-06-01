#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/quick-dashboard-bridge.sh [--env <name>] [options]

Shortcut flow for the dashboard bridge:
  1. Validate the bridge code locally
  2. Deploy only the AgentCore runtime container
  3. Run the dashboard snapshot smoke test against a fresh runtime session

Options:
  --env <name>        Load .env.<name> (for example .env.dev or .env.prod)
  --skip-checks       Skip local syntax/unit checks
  --skip-deploy       Skip runtime-only deploy
  --skip-test         Skip the deployed runtime smoke test
  --actor-id <id>     Override smoke-test actor ID
  --channel <name>    Override smoke-test channel
  --pretty            Pretty-print the smoke-test JSON response
  -h, --help          Show this help text

Examples:
  ./scripts/quick-dashboard-bridge.sh --env dev
  ./scripts/quick-dashboard-bridge.sh --env dev --skip-deploy
  ./scripts/quick-dashboard-bridge.sh --env prod --actor-id telegram:123456 --channel telegram
EOF
}

OPENCLAW_ENV_NAME="${OPENCLAW_ENV_NAME:-}"
RUN_CHECKS=1
RUN_DEPLOY=1
RUN_TEST=1
PRETTY=0
ACTOR_ID=""
CHANNEL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "ERROR: --env requires a value."
        usage
        exit 1
      fi
      OPENCLAW_ENV_NAME="$2"
      shift 2
      ;;
    --env=*)
      OPENCLAW_ENV_NAME="${1#*=}"
      if [ -z "$OPENCLAW_ENV_NAME" ]; then
        echo "ERROR: --env requires a value."
        usage
        exit 1
      fi
      shift
      ;;
    --skip-checks)
      RUN_CHECKS=0
      shift
      ;;
    --skip-deploy)
      RUN_DEPLOY=0
      shift
      ;;
    --skip-test)
      RUN_TEST=0
      shift
      ;;
    --actor-id)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "ERROR: --actor-id requires a value."
        usage
        exit 1
      fi
      ACTOR_ID="$2"
      shift 2
      ;;
    --channel)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "ERROR: --channel requires a value."
        usage
        exit 1
      fi
      CHANNEL="$2"
      shift 2
      ;;
    --pretty)
      PRETTY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

export OPENCLAW_ENV_NAME
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/openclaw-env.sh"
load_project_env "$PROJECT_DIR" "$OPENCLAW_ENV_NAME"
apply_named_environment "$OPENCLAW_ENV_NAME"

RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
if [ -z "$ACTOR_ID" ]; then
  ACTOR_ID="test:dashboard-smoke-${RUN_ID}"
fi
RUNTIME_SESSION_ID="dashboard_smoke_${RUN_ID//[^a-zA-Z0-9_]/_}"

echo "INFO: Environment file: ${OPENCLAW_SELECTED_ENV_FILE:-"(none)"}"
echo "INFO: Environment suffix: ${OPENCLAW_ENV_SUFFIX:-"(default)"}"
echo "INFO: Smoke-test actor ID: $ACTOR_ID"
echo "INFO: Smoke-test session: $RUNTIME_SESSION_ID"

if [ "$RUN_CHECKS" -eq 1 ]; then
  echo
  echo "==> Running local bridge checks"
  (
    cd "$PROJECT_DIR"
    node --check bridge/agentcore-contract.js
    node --check bridge/dashboard-gateway.js
    python3 -m py_compile scripts/test-dashboard-bridge.py
    cd bridge
    node --test dashboard-gateway.test.js
  )
fi

if [ "$RUN_DEPLOY" -eq 1 ]; then
  echo
  echo "==> Deploying runtime only"
  deploy_cmd=(./scripts/deploy.sh --runtime-only)
  if [ -n "$OPENCLAW_ENV_NAME" ]; then
    deploy_cmd+=(--env "$OPENCLAW_ENV_NAME")
  fi
  (
    cd "$PROJECT_DIR"
    "${deploy_cmd[@]}"
  )
fi

if [ "$RUN_TEST" -eq 1 ]; then
  echo
  echo "==> Running dashboard snapshot smoke test"
  test_cmd=(python3 scripts/test-dashboard-bridge.py --actor-id "$ACTOR_ID" --runtime-session-id "$RUNTIME_SESSION_ID")
  if [ -n "$OPENCLAW_ENV_NAME" ]; then
    test_cmd+=(--env "$OPENCLAW_ENV_NAME")
  fi
  if [ -n "$CHANNEL" ]; then
    test_cmd+=(--channel "$CHANNEL")
  fi
  if [ "$PRETTY" -eq 1 ]; then
    test_cmd+=(--pretty)
  fi
  (
    cd "$PROJECT_DIR"
    "${test_cmd[@]}"
  )
fi

echo
echo "Done."
