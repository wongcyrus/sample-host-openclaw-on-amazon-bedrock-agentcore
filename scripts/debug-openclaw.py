#!/usr/bin/env python3
"""Download native OpenClaw logs and safe skill diagnostics from an existing session."""

import argparse
import json
import os
from pathlib import Path

import boto3
from botocore.config import Config


def collect(*, region, suffix, actor_id, limit, check_mcp=False):
    cf = boto3.client("cloudformation", region_name=region)
    stack = f"OpenClawAgentCore-{suffix}"
    outputs = {
        item["OutputKey"]: item["OutputValue"]
        for item in cf.describe_stacks(StackName=stack)["Stacks"][0]["Outputs"]
    }
    table = boto3.resource("dynamodb", region_name=region).Table(f"openclaw-identity-{suffix}")
    profile = table.get_item(
        Key={"PK": f"CHANNEL#{actor_id}", "SK": "PROFILE"}, ConsistentRead=True,
    ).get("Item")
    if not profile:
        raise RuntimeError("Actor has no registered identity in the selected environment")
    user_id = profile["userId"]
    session = table.get_item(
        Key={"PK": f"USER#{user_id}", "SK": "SESSION"}, ConsistentRead=True,
    ).get("Item")
    if not session:
        raise RuntimeError("No existing session; send a message and wait for OpenClaw startup first")
    client = boto3.client(
        "bedrock-agentcore", region_name=region,
        config=Config(read_timeout=90, retries={"max_attempts": 0}),
    )
    response = client.invoke_agent_runtime(
        agentRuntimeArn=outputs["RuntimeArn"],
        qualifier=outputs["RuntimeEndpointId"],
        runtimeSessionId=session["sessionId"],
        payload=json.dumps({"action": "diagnostics", "userId": user_id, "limit": limit,
                            "checkMcp": check_mcp}).encode(),
        contentType="application/json",
        accept="application/json",
    )
    data = json.loads(response["response"].read())
    if data.get("status") != "ready" or not isinstance(data.get("nativeLogs"), str):
        raise RuntimeError(data.get("error", "Runtime does not support diagnostics or is not ready"))
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", required=True, choices=["dev", "prod"])
    parser.add_argument("--region", default=os.environ.get("CDK_DEFAULT_REGION", "us-east-1"))
    parser.add_argument("--actor-id", required=True)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--check-mcp", action="store_true", help="Run the skill's read-only signed tools/list")
    args = parser.parse_args()
    if not 1 <= args.limit <= 2000:
        parser.error("--limit must be between 1 and 2000")
    if args.output.exists():
        parser.error("--output already exists; choose a new private file")
    data = collect(region=args.region, suffix=args.env, actor_id=args.actor_id,
                   limit=args.limit, check_mcp=args.check_mcp)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream, indent=2)
    print(f"Saved native logs and skill diagnostics to {args.output} (mode 0600)")
    for name, skill in data.get("skills", {}).items():
        print(f"{name}: enabled={skill['enabled']} matches_runtime={skill['matchesRuntime']}")
    if data.get("mcpConnection"):
        print(f"MCP HTTP {data['mcpConnection']['httpStatus']}; tools={len(data['mcpConnection']['toolNames'])}")


if __name__ == "__main__":
    main()
