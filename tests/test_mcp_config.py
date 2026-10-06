import pytest

from stacks.mcp_config import resolve_mcp_config


def test_selected_env_overrides_stale_context_and_scopes_gateway():
    context = {
        "humanoid_mcp_server_url": "https://old.invalid/mcp",
        "humanoid_mcp_function_arn": "arn:aws:lambda:us-east-1:123456789012:function:old",
    }
    env = {
        "HUMANOID_MCP_SERVER_URL": "https://new-123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        "HUMANOID_MCP_AUTH_MODE": "iam",
    }
    result = resolve_mcp_config(env, context.get, account="123456789012", region="us-east-1")
    assert result["url"] == env["HUMANOID_MCP_SERVER_URL"]
    assert result["arn"] == "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/new-123"


def test_context_remains_fallback_for_existing_deployments():
    result = resolve_mcp_config({}, {"humanoid_mcp_server_url": "https://legacy.invalid/mcp"}.get,
                                account="123456789012", region="us-east-1")
    assert result["url"] == "https://legacy.invalid/mcp"
    assert result["auth"] == "iam"


def test_cross_region_gateway_is_rejected():
    with pytest.raises(ValueError, match="region"):
        resolve_mcp_config(
            {"HUMANOID_MCP_SERVER_URL": "https://new.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp"},
            {}.get, account="123456789012", region="us-east-1",
        )
