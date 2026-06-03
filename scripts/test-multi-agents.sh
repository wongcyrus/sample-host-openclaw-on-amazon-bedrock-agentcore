#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-us-east-1}"
STACK="${STACK:-OpenClawAgentCore-dev}"
SESSION_ID="${SESSION_ID:-ses_debug_multi_agent_12345678901234567890}"
USER_ID="${USER_ID:-debug_multi}"
ACTOR_ID="${ACTOR_ID:-debug:multi}"
CHANNEL="${CHANNEL:-test}"

RUNTIME_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='RuntimeArn'].OutputValue | [0]" \
    --output text
)"

QUALIFIER="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='RuntimeEndpointId'].OutputValue | [0]" \
    --output text
)"

invoke_runtime() {
  local payload="$1"
  local outfile="$2"

  aws bedrock-agentcore invoke-agent-runtime \
    --region "$REGION" \
    --agent-runtime-arn "$RUNTIME_ARN" \
    --qualifier "$QUALIFIER" \
    --content-type application/json \
    --accept application/json \
    --runtime-session-id "$SESSION_ID" \
    --payload "$payload" \
    "$outfile" \
    --cli-binary-format raw-in-base64-out >/dev/null
}

show_response() {
  python3 - "$1" <<'PY'
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text()
print(raw)
try:
    obj = json.loads(raw)
    response = obj.get("response")
    if isinstance(response, str):
        try:
            print("--- parsed response ---")
            print(json.dumps(json.loads(response), indent=2))
        except Exception:
            print("--- response text ---")
            print(response)
except Exception:
    pass
PY
}

wait_until_ready() {
  local outfile="$1"
  local attempts="${2:-6}"
  local sleep_seconds="${3:-10}"

  for _ in $(seq 1 "$attempts"); do
    invoke_runtime '{"action":"status"}' "$outfile"
    if python3 - "$outfile" <<'PY'
import json
import sys

obj = json.load(open(sys.argv[1]))
response = json.loads(obj["response"])
raise SystemExit(0 if response.get("openclawReady") and response.get("proxyReady") else 1)
PY
    then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  return 1
}

build_chat_payload() {
  local message="$1"
  python3 - "$USER_ID" "$ACTOR_ID" "$CHANNEL" "$message" <<'PY'
import json
import sys

user_id, actor_id, channel, message = sys.argv[1:5]
print(json.dumps({
    "action": "chat",
    "userId": user_id,
    "actorId": actor_id,
    "channel": channel,
    "message": message,
}))
PY
}

STATUS_BEFORE="$(mktemp)"
CHAT_WARMUP="$(mktemp)"
STATUS_AFTER="$(mktemp)"
CHAT_MULTI="$(mktemp)"

trap 'rm -f "$STATUS_BEFORE" "$CHAT_WARMUP" "$STATUS_AFTER" "$CHAT_MULTI"' EXIT

echo "RUNTIME_ARN=$RUNTIME_ARN"
echo "QUALIFIER=$QUALIFIER"
echo "SESSION_ID=$SESSION_ID"
echo

invoke_runtime '{"action":"status"}' "$STATUS_BEFORE"
echo '--- status before init ---'
show_response "$STATUS_BEFORE"
echo

invoke_runtime "$(build_chat_payload 'hello')" "$CHAT_WARMUP"
echo '--- warmup chat response ---'
show_response "$CHAT_WARMUP"
echo

if ! wait_until_ready "$STATUS_AFTER"; then
  echo "ERROR: runtime did not become ready within the wait window" >&2
  echo '--- last status ---'
  show_response "$STATUS_AFTER"
  exit 1
fi

echo '--- status after init wait ---'
show_response "$STATUS_AFTER"
echo

invoke_runtime "$(build_chat_payload 'List the exact agent IDs you can delegate to or use as subagents. Reply with only IDs, comma-separated.')" "$CHAT_MULTI"
echo '--- multi-agent probe response ---'
show_response "$CHAT_MULTI"
