---
name: digital_human
description: Control xiaoice Digital Human speech via an MCP endpoint. Send text for the presenter to speak aloud.
---

# Digital Human Skill

Controls the xiaoice Digital Human through the same MCP server configured for the humanoid integration.

## Usage

Run the bundled launcher from the skill directory:

```bash
cd {baseDir} && ./run.sh --message "Hello, welcome to the exhibition" --json
```

Examples:

```bash
cd {baseDir} && ./run.sh --message "Hello, welcome to the exhibition"
cd {baseDir} && ./run.sh --message "歡迎嚟到我哋嘅展覽"
cd {baseDir} && ./run.sh --message "The next match is starting now" --json
```

## Required Environment

- The runtime reuses `HUMANOID_MCP_SERVER_URL` for this skill's MCP endpoint
- The runtime reuses `HUMANOID_MCP_AUTH_MODE` and `HUMANOID_MCP_API_KEY_HEADER` for auth configuration
- AWS credentials are provided by the AgentCore runtime automatically

If you use API-key mode, provide the key to the skill process securely and avoid hardcoding it into source control.

## Notes

- This skill sends speech messages to the single xiaoice presenter context (`current_presenter`)
- It is intended for presenter or commentary workflows such as `domain-commentator`
