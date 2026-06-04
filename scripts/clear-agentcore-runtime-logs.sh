#!/usr/bin/env bash
# Delete the current AgentCore runtime CloudWatch Logs group.
#
# CloudWatch Logs does not support deleting individual log lines, so this
# script resolves the currently deployed runtime and deletes its whole log
# group. AgentCore recreates the group automatically when new logs arrive.
#
# Usage:
#   ./scripts/clear-agentcore-runtime-logs.sh
#   ./scripts/clear-agentcore-runtime-logs.sh --env dev
#   ./scripts/clear-agentcore-runtime-logs.sh --env dev --yes
#   ./scripts/clear-agentcore-runtime-logs.sh --env dev --print-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/openclaw-env.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/clear-agentcore-runtime-logs.sh [--env <name>] [--yes] [--print-only]

Options:
  --env <name>   Load .env.<name> and require OPENCLAW_ENV_SUFFIX to match.
  --yes          Delete without interactive confirmation.
  --print-only   Print the resolved log group and exit without deleting it.
  -h, --help     Show this help text.
EOF
}

OPENCLAW_ENV_NAME="${OPENCLAW_ENV_NAME:-}"
ASSUME_YES=0
PRINT_ONLY=0

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
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --print-only)
      PRINT_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

load_project_env "$PROJECT_DIR" "$OPENCLAW_ENV_NAME"
apply_named_environment "$OPENCLAW_ENV_NAME"

REGION="${CDK_DEFAULT_REGION:-${AWS_REGION:-us-west-2}}"
PROFILE_ARG=()
if [ -n "${AWS_PROFILE:-}" ]; then
  PROFILE_ARG=(--profile "$AWS_PROFILE")
fi

RUNTIME_ARN_PARAMETER="$(with_suffix "/openclaw/agentcore/runtime-arn")"
QUALIFIER_PARAMETER="$(with_suffix "/openclaw/agentcore/runtime-endpoint-id")"

runtime_arn="$(aws ssm get-parameter \
  --name "$RUNTIME_ARN_PARAMETER" \
  --region "$REGION" \
  "${PROFILE_ARG[@]}" \
  --query 'Parameter.Value' \
  --output text)"

qualifier="$(aws ssm get-parameter \
  --name "$QUALIFIER_PARAMETER" \
  --region "$REGION" \
  "${PROFILE_ARG[@]}" \
  --query 'Parameter.Value' \
  --output text)"

runtime_id="${runtime_arn##*/}"
log_group_name="/aws/bedrock-agentcore/runtimes/${runtime_id}-${qualifier}"

existing_log_group="$(aws logs describe-log-groups \
  --log-group-name-prefix "$log_group_name" \
  --region "$REGION" \
  "${PROFILE_ARG[@]}" \
  --query "logGroups[?logGroupName=='$log_group_name'].logGroupName | [0]" \
  --output text)"

if [ "$PRINT_ONLY" -eq 1 ]; then
  echo "$log_group_name"
  exit 0
fi

if [ -z "$existing_log_group" ] || [ "$existing_log_group" = "None" ]; then
  echo "No AgentCore runtime log group found for current deployment:"
  echo "  $log_group_name"
  exit 0
fi

echo "Resolved runtime ARN: $runtime_arn"
echo "Resolved qualifier:   $qualifier"
echo "Deleting log group:   $log_group_name"

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Delete this CloudWatch log group? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

aws logs delete-log-group \
  --log-group-name "$log_group_name" \
  --region "$REGION" \
  "${PROFILE_ARG[@]}"

echo "Deleted $log_group_name"
