"""Digital Human skill - control xiaoice presenter speech via an MCP endpoint."""

import argparse
import json
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def normalize_auth_mode(raw_mode):
    """Normalize auth mode and fall back to IAM."""
    mode = (raw_mode or "iam").strip().lower()
    if mode in {"iam", "api-key", "none"}:
        return mode
    logger.warning("Unknown MCP auth mode '%s'; defaulting to iam", raw_mode)
    return "iam"


def create_auth(auth_mode, region, mcp_url, profile_name=""):
    """Create a request auth object for the selected mode."""
    if auth_mode != "iam":
        return None

    import boto3
    from requests_auth_aws_sigv4 import AWSSigV4

    session_kwargs = {"region_name": region}
    if profile_name:
        session_kwargs["profile_name"] = profile_name
    session = boto3.Session(**session_kwargs)
    service = "bedrock-agentcore"
    return AWSSigV4(service, session=session)


def build_headers(api_key_header, api_key):
    """Build headers for an MCP request."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers[api_key_header] = api_key
    return headers


def call_mcp_tool(mcp_url, auth, tool_name, arguments, timeout=30, headers=None):
    """Call an MCP tool and return the first text block on success."""
    import requests

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    try:
        response = requests.post(
            mcp_url,
            json=payload,
            headers=headers or {"Content-Type": "application/json"},
            auth=auth,
            timeout=timeout,
        )
        response.raise_for_status()
        result = response.json()
    except Exception as exc:
        logger.error("MCP request failed: %s", exc)
        return None

    if "error" in result:
        logger.error("MCP error: %s", result["error"])
        return None

    content = result.get("result", {}).get("content", [])
    return next((entry.get("text", "") for entry in content if entry.get("type") == "text"), "")


def execute_speech(mcp_url, auth, headers, message):
    """Send a speech command to the digital human MCP server."""
    tool_name = "digital-human-mcp-lambda___digital_human_speech"
    text = call_mcp_tool(
        mcp_url,
        auth,
        tool_name,
        {"message": message},
        headers=headers,
    )
    if text is not None:
        logger.info("speech -> %s", text)
        return True, text
    return False, "Failed to send speech to digital human"


def main():
    parser = argparse.ArgumentParser(
        description="Digital Human skill - control xiaoice presenter speech via MCP",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  %(prog)s --message "Hello, welcome"
  %(prog)s --message "The show is starting"
  %(prog)s --message "歡迎嚟到我哋嘅展覽" --json
""",
    )
    parser.add_argument(
        "--profile",
        default=os.environ.get("AWS_PROFILE", ""),
        help="Optional AWS CLI profile name for local runs",
    )
    parser.add_argument(
        "--message",
        required=True,
        help="Text message for the digital human to speak",
    )
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION", "us-east-1"),
        help="AWS region",
    )
    parser.add_argument(
        "--mcp-url",
        default=os.environ.get("MCP_SERVER_URL", ""),
        help="MCP endpoint URL (or set MCP_SERVER_URL)",
    )
    parser.add_argument(
        "--auth-mode",
        default=os.environ.get("MCP_AUTH_MODE", "iam"),
        help="MCP auth mode: iam, api-key, or none. Default: iam",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("MCP_API_KEY") or os.environ.get("HUMANOID_MCP_API_KEY", ""),
        help="Optional API key for MCP endpoints that require one",
    )
    parser.add_argument(
        "--api-key-header",
        default=os.environ.get("MCP_API_KEY_HEADER", "x-api-key"),
        help="Header name for --api-key. Default: x-api-key",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Output results as JSON",
    )
    args = parser.parse_args()

    if not args.mcp_url:
        logger.error("--mcp-url or MCP_SERVER_URL is required")
        sys.exit(1)

    if not args.message.strip():
        logger.error("--message cannot be empty")
        sys.exit(1)

    auth_mode = normalize_auth_mode(args.auth_mode)
    if auth_mode == "api-key" and not args.api_key:
        logger.error("--api-key or MCP_API_KEY is required when --auth-mode=api-key")
        sys.exit(1)

    auth = create_auth(auth_mode, args.region, args.mcp_url, args.profile)
    headers = build_headers(args.api_key_header, args.api_key if auth_mode == "api-key" else "")
    success, response_text = execute_speech(args.mcp_url, auth, headers, args.message)

    if args.json_output:
        print(
            json.dumps(
                {
                    "success": success,
                    "message": args.message,
                    "response": response_text,
                },
                indent=2,
            )
        )
    else:
        if success:
            print(response_text)
        else:
            print(f"Error: {response_text}", file=sys.stderr)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
