"""Humanoid skill - control humanoid robots via an MCP endpoint."""

import argparse
import json
import logging
import os
import re
import sys
import time
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

ACTION_CATALOG = {
    "movement": {
        "go_forward": 3.5,
        "back_fast": 4.5,
        "turn_left": 4,
        "turn_right": 4,
        "left_move_fast": 3,
        "right_move_fast": 3,
        "stepping": 3,
    },
    "dance": {
        "dance_one": 85,
        "dance_two": 52,
        "dance_three": 70,
        "dance_four": 83,
        "dance_five": 59,
        "dance_six": 69,
        "dance_seven": 67,
        "dance_eight": 85,
        "dance_nine": 84,
        "dance_ten": 85,
    },
    "combat": {
        "kung_fu": 2,
        "wing_chun": 2,
        "left_kick": 2,
        "right_kick": 2,
        "left_uppercut": 2,
        "right_uppercut": 2,
        "left_shot_fast": 4,
        "right_shot_fast": 4,
    },
    "exercise": {
        "push_ups": 9,
        "sit_ups": 12,
        "squat": 1,
        "squat_up": 6,
        "weightlifting": 9,
        "chest": 9,
    },
    "posture": {
        "stand": 2,
        "stand_up_back": 5,
        "stand_up_front": 5,
    },
    "gesture": {
        "wave": 3.5,
        "bow": 4,
        "twist": 4,
    },
    "control": {
        "stop": 0,
    },
}

ALL_ACTIONS = {}
for actions in ACTION_CATALOG.values():
    ALL_ACTIONS.update(actions)


def normalize_auth_mode(raw_mode):
    """Normalize auth mode and fall back to IAM."""
    mode = (raw_mode or "iam").strip().lower()
    if mode in {"iam", "api-key", "none"}:
        return mode
    logger.warning("Unknown MCP auth mode '%s'; defaulting to iam", raw_mode)
    return "iam"


def create_auth(auth_mode, region):
    """Create a request auth object for the selected mode."""
    if auth_mode != "iam":
        return None

    import boto3
    from requests_auth_aws_sigv4 import AWSSigV4

    session = boto3.Session(region_name=region)
    return AWSSigV4("lambda", session=session)


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


def execute_action(mcp_url, auth, headers, robot_id, action):
    """Execute a single action against one robot."""
    tool_name = f"robot_{action}"
    text = call_mcp_tool(mcp_url, auth, tool_name, {"robot_id": robot_id}, headers=headers)
    if text is not None:
        logger.info("[%s] %s -> %s", robot_id, action, text)
        return True, text
    return False, f"Failed to execute {action}"


def execute_speech(mcp_url, auth, headers, robot_id, text, language="yue"):
    """Make the robot speak via the MCP server."""
    arguments = {
        "robot_id": robot_id,
        "text": text,
        "language": language,
    }
    result = call_mcp_tool(mcp_url, auth, "robot_speak", arguments, timeout=30, headers=headers)
    if result is not None:
        logger.info("[%s] speak(%s) -> %s", robot_id, language, result)
        return True, result
    return False, f"Failed to send speech to {robot_id}"


def capture_image(mcp_url, auth, headers, robot_id):
    """Capture an image, download it locally, and return the file path."""
    import requests

    text = call_mcp_tool(
        mcp_url,
        auth,
        "get_image",
        {"robot_id": robot_id},
        timeout=30,
        headers=headers,
    )
    if text is None:
        return None

    if "Cannot read image" in text:
        logger.error("Robot did not upload image: %s", text)
        return None

    url_match = re.search(r"image_url=(\S+)", text)
    if not url_match:
        logger.error("No image_url found in MCP response: %s", text)
        return None

    try:
        image_response = requests.get(url_match.group(1), timeout=30)
        image_response.raise_for_status()
    except Exception as exc:
        logger.error("Failed to download image: %s", exc)
        return None

    local_dir = os.environ.get("HUMANOID_CAPTURE_DIR", "/tmp/openclaw-humanoid-images")
    os.makedirs(local_dir, exist_ok=True)
    local_path = os.path.join(local_dir, f"{robot_id}_{uuid.uuid4().hex[:8]}.jpg")

    with open(local_path, "wb") as output_file:
        output_file.write(image_response.content)

    logger.info("Image saved to %s (%d bytes)", local_path, len(image_response.content))
    return local_path


def validate_action(action):
    """Validate that an action exists and suggest close matches when possible."""
    if action in ALL_ACTIONS or action == "capture_image":
        return True, None
    from difflib import get_close_matches

    matches = get_close_matches(action, list(ALL_ACTIONS.keys()), n=3, cutoff=0.6)
    return False, matches


def list_actions():
    """Print all available actions grouped by category."""
    output = {"categories": {}, "total_actions": len(ALL_ACTIONS) + 1}
    for category, actions in ACTION_CATALOG.items():
        output["categories"][category] = {
            name: f"{duration}s" for name, duration in actions.items()
        }
    output["categories"]["image"] = {"capture_image": "~15s"}
    print(json.dumps(output, indent=2))


def run_sequence(mcp_url, auth, headers, robot_id, actions, wait):
    """Execute a sequence of robot actions."""
    results = []
    for action in actions:
        action = action.strip()
        if not action:
            continue

        valid, suggestions = validate_action(action)
        if not valid:
            message = f"Unknown action: {action}"
            if suggestions:
                message += f" (did you mean: {', '.join(suggestions)}?)"
            logger.error(message)
            results.append({"action": action, "success": False, "error": message})
            continue

        if action == "capture_image":
            path = capture_image(mcp_url, auth, headers, robot_id)
            results.append(
                {
                    "action": action,
                    "robot_id": robot_id,
                    "success": path is not None,
                    "file": path,
                }
            )
        else:
            ok, text = execute_action(mcp_url, auth, headers, robot_id, action)
            results.append(
                {
                    "action": action,
                    "robot_id": robot_id,
                    "success": ok,
                    "response": text,
                }
            )

        if wait and action in ALL_ACTIONS:
            duration = ALL_ACTIONS[action]
            if duration > 0:
                wait_time = min(duration, wait) if wait != -1 else duration
                logger.info("Waiting %.1fs for '%s' to complete...", wait_time, action)
                time.sleep(wait_time)

    return results


def print_human_output(results):
    """Emit readable stdout for OpenClaw skill execution."""
    for result in results:
        action = result.get("action", "action")
        robot_id = result.get("robot_id")
        prefix = f"[{robot_id}] {action}: " if robot_id else f"{action}: "
        if result.get("success"):
            print(result.get("response") or result.get("file") or f"{prefix}ok")
        else:
            print(prefix + (result.get("error") or result.get("response") or "failed"))


def main():
    parser = argparse.ArgumentParser(
        description="Humanoid skill - control one humanoid robot via MCP",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  %(prog)s --robot-id robot_1 --action wave
  %(prog)s --robot-id robot_1 --sequence "wave,bow,dance_one"
  %(prog)s --robot-id robot_1 --sequence "wave,push_ups,bow" --wait
  %(prog)s --robot-id robot_1 --speak "Hello, welcome" --language en
  %(prog)s --list-actions
""",
    )
    parser.add_argument("--robot-id", help="Robot ID (for example robot_1)")
    parser.add_argument("--action", help="Single action to execute")
    parser.add_argument("--sequence", help="Comma-separated list of actions to execute in order")
    parser.add_argument("--speak", help="Text for the robot to speak aloud")
    parser.add_argument(
        "--language",
        default="yue",
        choices=["yue", "cmn", "en", "ja", "ko"],
        help="Speech language. Default: yue",
    )
    parser.add_argument(
        "--wait",
        nargs="?",
        const=-1,
        type=float,
        default=0,
        help="Wait for action duration between sequence steps, or pass a fixed number of seconds.",
    )
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION", "us-east-1"),
        help="AWS region for SigV4 signing",
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
        help="Header name to use with --api-key. Default: x-api-key",
    )
    parser.add_argument("--list-actions", action="store_true", help="List all available actions")
    parser.add_argument("--json", action="store_true", dest="json_output", help="Output JSON")
    args = parser.parse_args()

    if args.list_actions:
        list_actions()
        sys.exit(0)

    if not args.robot_id:
        parser.error("--robot-id is required (unless using --list-actions)")
    if not args.action and not args.sequence and not args.speak:
        parser.error("--action, --sequence, or --speak is required")
    if not args.mcp_url:
        logger.error("--mcp-url or MCP_SERVER_URL is required")
        sys.exit(1)

    auth_mode = normalize_auth_mode(args.auth_mode)
    if auth_mode == "api-key" and not args.api_key:
        logger.error("--api-key or MCP_API_KEY is required when --auth-mode=api-key")
        sys.exit(1)

    auth = create_auth(auth_mode, args.region)
    headers = build_headers(args.api_key_header, args.api_key)

    if args.speak:
        ok, text = execute_speech(
            args.mcp_url,
            auth,
            headers,
            args.robot_id,
            args.speak,
            args.language,
        )
        results = [{"action": "speak", "robot_id": args.robot_id, "success": ok, "response": text}]
        actions = ["speak"]
    else:
        actions = [a.strip() for a in args.sequence.split(",")] if args.sequence else [args.action]
        results = run_sequence(args.mcp_url, auth, headers, args.robot_id, actions, args.wait)

    success = all(result.get("success") for result in results)

    if args.json_output:
        print(json.dumps({"success": success, "results": results}, indent=2))
    else:
        print_human_output(results)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
