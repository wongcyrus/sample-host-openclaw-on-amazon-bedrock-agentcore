---
name: humanoid
description: Control a humanoid robot through an MCP endpoint. Supports robot actions, action sequences, speech, and image capture for robot-specific agents.
---

# Humanoid Skill

Controls a single humanoid robot through the MCP server configured by `HUMANOID_MCP_SERVER_URL`.

## Usage

Run the bundled launcher from the skill directory:

```bash
cd {baseDir} && ./run.sh --robot-id robot_1 --action wave --json
```

Examples:

```bash
cd {baseDir} && ./run.sh --robot-id robot_1 --action wave --json
cd {baseDir} && ./run.sh --robot-id robot_1 --sequence "wave,push_ups,bow" --wait --json
cd {baseDir} && ./run.sh --robot-id robot_1 --speak "Hello, welcome" --language en --json
cd {baseDir} && ./run.sh --robot-id robot_1 --action capture_image --json
cd {baseDir} && ./run.sh --list-actions
```

## Supported Robots

`robot_1`, `robot_2`, `robot_3`, `robot_4`, `robot_5`, `robot_6`

## Required Environment

- `HUMANOID_MCP_SERVER_URL` must be passed into the runtime deployment environment
- `HUMANOID_MCP_AUTH_MODE` defaults to `iam`; set it to `api-key` only if the endpoint requires an API key instead of SigV4
- AWS credentials are provided by the AgentCore runtime automatically

If you use API-key mode, provide the key to the skill process securely and avoid hardcoding it into source control.

## Notes

- Use the robot agent that matches the physical robot you want to control
- `capture_image` stores downloaded images in `/tmp/openclaw-humanoid-images`
- This skill is intended for robot-control agents, not the general chat agent
