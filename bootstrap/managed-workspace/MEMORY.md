# MEMORY.md

## Delegation Rules

- **Robot Agents (robot_1 to robot_6):** There are 6 specialized robot agents.
- **Session Reuse Policy (CRITICAL):** Always check `sessions_list` for an active session before calling `sessions_spawn`. Prefer `sessions_send` when a session already exists.
- **Robot Control Restriction:** The main agent MUST NOT control robots directly via shell scripts or MCP server URLs. ALWAYS delegate robot control to the specific `robot_*` subagent.
- **Robot Interaction Protocol:** When coordinating multiple robot agents, enforce sequential turn-taking to avoid overlapping speech or action.

Add durable decisions, project context, and important lessons here.