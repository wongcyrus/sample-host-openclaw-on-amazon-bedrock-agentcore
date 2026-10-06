import re


def resolve_mcp_config(env, context, *, account, region):
    def value(key, default=""):
        return str(env.get(key.upper()) or context(key) or default).strip()

    url = value("humanoid_mcp_server_url")
    auth = value("humanoid_mcp_auth_mode", "iam").lower()
    arn = value("humanoid_mcp_function_arn")
    gateway = re.fullmatch(
        r"https://([a-zA-Z0-9-]+)\.gateway\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com/mcp/?",
        url,
    )
    if gateway:
        if gateway[2] != region:
            raise ValueError("Humanoid MCP gateway must be in the runtime region")
        arn = f"arn:aws:bedrock-agentcore:{region}:{account}:gateway/{gateway[1]}"
    return {
        "url": url, "auth": auth, "arn": arn,
        "api_key_header": value("humanoid_mcp_api_key_header", "x-api-key"),
    }
