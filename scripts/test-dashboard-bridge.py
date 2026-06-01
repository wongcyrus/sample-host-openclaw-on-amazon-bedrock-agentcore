#!/usr/bin/env python3
"""Smoke test the dashboard snapshot bridge against a deployed AgentCore runtime.

Usage examples:
  python3 scripts/test-dashboard-bridge.py
  python3 scripts/test-dashboard-bridge.py --env dev
  python3 scripts/test-dashboard-bridge.py --actor-id telegram:123456 --channel telegram
  python3 scripts/test-dashboard-bridge.py --pretty

This invokes the contract server's `action: dashboard_snapshot` through the
AgentCore Runtime data plane. It is the safest first check because it verifies:
  1. AgentCore can reach the runtime contract
  2. The contract can initialize OpenClaw if needed
  3. The contract can connect to the internal OpenClaw gateway
  4. The dashboard snapshot response shape is valid
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError


def resolve_region(project_dir: Path) -> str:
    region = os.environ.get("CDK_DEFAULT_REGION") or os.environ.get("AWS_REGION")
    if region:
        return region

    cdk_json = project_dir / "cdk.json"
    if cdk_json.exists():
        with cdk_json.open(encoding="utf-8") as fh:
            region = str(json.load(fh).get("context", {}).get("region", "") or "")
            if region:
                return region

    session_region = boto3.session.Session().region_name
    if session_region:
        return session_region

    raise RuntimeError(
        "Could not determine AWS region. Set CDK_DEFAULT_REGION or configure AWS CLI."
    )


def resolve_env_suffix(project_dir: Path, explicit_env: str | None) -> str:
    raw = explicit_env
    if raw is None:
        raw = os.environ.get("OPENCLAW_ENV_SUFFIX")
    if raw is None:
        cdk_json = project_dir / "cdk.json"
        if cdk_json.exists():
            with cdk_json.open(encoding="utf-8") as fh:
                raw = str(
                    json.load(fh).get("context", {}).get("environment_suffix", "") or ""
                )
    raw = (raw or "").strip().lower().strip("-")
    if raw and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", raw):
        raise RuntimeError(
            "environment suffix must use lowercase letters, digits, and hyphens only"
        )
    return raw


def with_suffix(base: str, suffix: str) -> str:
    return f"{base}-{suffix}" if suffix else base


def resolve_runtime_outputs(region: str, stack_name: str) -> tuple[str, str]:
    cf = boto3.client("cloudformation", region_name=region)
    try:
        resp = cf.describe_stacks(StackName=stack_name)
    except ClientError as err:
        raise RuntimeError(f"Could not read CloudFormation stack {stack_name}: {err}") from err

    try:
        outputs = {
            item["OutputKey"]: item["OutputValue"]
            for item in resp["Stacks"][0].get("Outputs", [])
        }
    except (KeyError, IndexError) as err:
        raise RuntimeError(f"Malformed outputs for stack {stack_name}") from err

    runtime_arn = outputs.get("RuntimeArn")
    qualifier = outputs.get("RuntimeEndpointId")
    if not runtime_arn or not qualifier:
        raise RuntimeError(
            f"Stack {stack_name} is missing RuntimeArn or RuntimeEndpointId outputs"
        )
    return runtime_arn, qualifier


def default_user_id(actor_id: str) -> str:
    digest = hashlib.sha1(actor_id.encode("utf-8")).hexdigest()[:12]
    return f"dashboard-user-{digest}"


def default_runtime_session_id(actor_id: str) -> str:
    digest = hashlib.sha1(actor_id.encode("utf-8")).hexdigest()[:16]
    return f"dashboard_{digest}"


def invoke_dashboard_snapshot(
    *,
    region: str,
    runtime_arn: str,
    qualifier: str,
    runtime_session_id: str,
    user_id: str,
    actor_id: str,
    channel: str,
) -> dict:
    client = boto3.client("bedrock-agentcore", region_name=region)
    payload = {
        "action": "dashboard_snapshot",
        "userId": user_id,
        "actorId": actor_id,
        "channel": channel,
        "sessionId": runtime_session_id,
    }

    try:
        response = client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            qualifier=qualifier,
            runtimeSessionId=runtime_session_id,
            payload=json.dumps(payload).encode("utf-8"),
            contentType="application/json",
            accept="application/json",
        )
    except (ClientError, BotoCoreError) as err:
        raise RuntimeError(f"InvokeAgentRuntime failed: {err}") from err

    body = response.get("response")
    if body is None:
        raise RuntimeError("InvokeAgentRuntime returned no response body")
    body_text = body.read().decode("utf-8") if hasattr(body, "read") else str(body)

    try:
        parsed = json.loads(body_text)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"Response was not valid JSON: {body_text}") from err

    return parsed


def validate_snapshot_response(payload: dict) -> tuple[bool, str]:
    status = payload.get("status")
    if status != "ready":
        return False, f"status={status!r}, error={payload.get('error')!r}"

    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict):
        return False, "snapshot missing or not an object"

    required_keys = {"agents", "sessions", "presence", "identities", "source", "fetchedAt"}
    missing = sorted(required_keys - set(snapshot.keys()))
    if missing:
        return False, f"snapshot missing keys: {', '.join(missing)}"

    if not isinstance(snapshot.get("identities"), dict):
        return False, "snapshot.identities is not an object"

    return True, "ok"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env",
        help="Environment suffix to target (for example: dev or prod)",
    )
    parser.add_argument(
        "--stack-name",
        help="Override AgentCore stack name (default: OpenClawAgentCore[-suffix])",
    )
    parser.add_argument(
        "--region",
        help="AWS region override",
    )
    parser.add_argument(
        "--actor-id",
        default="test:dashboard",
        help="Actor identity for the runtime session (default: test:dashboard)",
    )
    parser.add_argument(
        "--channel",
        help="Channel name override (default: prefix of actor-id, else 'test')",
    )
    parser.add_argument(
        "--user-id",
        help="Internal user ID override (default: stable hash from actor-id)",
    )
    parser.add_argument(
        "--runtime-session-id",
        help="Runtime session ID override (default: stable hash from actor-id)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the full JSON response",
    )
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parents[1]
    region = args.region or resolve_region(project_dir)
    suffix = resolve_env_suffix(project_dir, args.env)
    stack_name = args.stack_name or with_suffix("OpenClawAgentCore", suffix)
    actor_id = args.actor_id
    channel = args.channel or (actor_id.split(":", 1)[0] if ":" in actor_id else "test")
    user_id = args.user_id or default_user_id(actor_id)
    runtime_session_id = args.runtime_session_id or default_runtime_session_id(actor_id)

    runtime_arn, qualifier = resolve_runtime_outputs(region, stack_name)

    print(f"Region:             {region}")
    print(f"Environment suffix: {suffix or '(none)'}")
    print(f"Stack:              {stack_name}")
    print(f"Runtime session:    {runtime_session_id}")
    print(f"Actor ID:           {actor_id}")
    print(f"User ID:            {user_id}")
    print(f"Channel:            {channel}")
    print("")
    print("Invoking dashboard_snapshot...")

    payload = invoke_dashboard_snapshot(
        region=region,
        runtime_arn=runtime_arn,
        qualifier=qualifier,
        runtime_session_id=runtime_session_id,
        user_id=user_id,
        actor_id=actor_id,
        channel=channel,
    )

    ok, reason = validate_snapshot_response(payload)
    if not ok:
        print("FAILED")
        print(reason)
        if args.pretty:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(json.dumps(payload))
        return 1

    snapshot = payload["snapshot"]
    agents = snapshot.get("agents", {})
    sessions = snapshot.get("sessions", {})
    agent_count = (
        len(agents.get("agents", []))
        if isinstance(agents, dict) and isinstance(agents.get("agents"), list)
        else "unknown"
    )
    session_count = (
        len(sessions.get("sessions", []))
        if isinstance(sessions, dict) and isinstance(sessions.get("sessions"), list)
        else "unknown"
    )

    print("OK")
    print(f"Agents discovered:   {agent_count}")
    print(f"Sessions discovered: {session_count}")
    print(f"Snapshot source:     {snapshot.get('source')}")
    print(f"Fetched at:          {snapshot.get('fetchedAt')}")

    if args.pretty:
        print("")
        print(json.dumps(payload, indent=2, sort_keys=True))

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        raise SystemExit(1)
