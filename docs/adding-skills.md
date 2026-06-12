# Adding Skills to OpenClaw on AgentCore

Because OpenClaw runs inside a custom, headless AgentCore container rather than a local desktop environment, the process for adding skills is slightly different than standard OpenClaw. 

There are two primary ways to add skills to the system: **Community Skills (ClawHub)** and **Custom Enterprise Skills**.

---

## Method 1: Adding a Community Skill (ClawHub)

ClawHub is the community package manager for OpenClaw. Skills installed via ClawHub are automatically scanned and loaded by the runtime.

### For a single user/session (On-the-fly)
You can ask your agent to install a skill directly in the chat:
> *"Use your clawhub-manage tool to install the `github-repo-reader` skill."*

The agent will execute the installation script, and the skill will be available upon the next session start. This applies only to that specific user's container.

### For all users (Baked into the container)
If you want a community skill to be permanently available for all users on startup, you must add it to the container image build process.

1. Open `bridge/Dockerfile.cdk`.
2. Locate the ClawHub install loop (around line 22).
3. Add the skill name to the `for skill in ...` list:

```dockerfile
# Install ClawHub community skills
RUN for skill in jina-reader deep-research-pro telegram-compose transcript task-decomposer YOUR_NEW_SKILL_HERE; do \
      for attempt in 1 2 3 4 5; do \
        clawhub install "$skill" --no-input --force && break; \
        echo "Retry $attempt for $skill (waiting 15s)..."; \
        sleep 15; \
      done; \
    done
```

---

## Method 2: Adding a Custom Internal Skill

If you are developing a completely custom skill tailored to your infrastructure (like `eventbridge-cron`, `humanoid`, or `digital_human`), follow this 4-step pipeline to register it properly with the container and proxy.

### 1. Create the Skill Directory
Create a new folder in `bridge/skills/` (e.g., `bridge/skills/my_new_skill`). 

Inside this directory, you **MUST** include a `SKILL.md` file. This file acts as the tool definition/schema that OpenClaw sends to the LLM. It defines the name, description, and exactly how the LLM should execute it via the terminal.

```markdown
---
name: my_new_skill
description: Fetches proprietary data from internal systems
---

# Usage
Run the script using Node.js:
`node {baseDir}/run.js --query "value"`
```
*Note: `{baseDir}` is dynamically replaced by OpenClaw with the absolute path to your skill folder.*

### 2. Copy the Skill into the Docker Image
Open `bridge/Dockerfile.cdk` and copy your new folder into the `/skills/` directory of the container image. Make sure the entrypoint scripts are executable.

```dockerfile
COPY bridge/skills/my_new_skill /skills/my_new_skill
RUN chmod +x /skills/my_new_skill/run.js
```

### 3. Register it in the OpenClaw Contract
Open `bridge/agentcore-contract.js`. This file generates the `openclaw.json` configuration injected into the microVM.

Scroll down to the `config` object, under `skills.entries` (around line 885). You must explicitly enable your skill and pass it any necessary environment variables (like API keys or endpoints):

```javascript
    skills: {
      allowBundled: [],
      load: { extraDirs: ["/skills"] },
      entries: {
        my_new_skill: {
          enabled: true,
          env: {
            INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
            AWS_REGION: process.env.AWS_REGION || "us-east-1",
          },
        },
        // ... existing skills
      }
    }
```
*Note: The environment variables defined here must be passed from the CDK stack into the AgentCore Lambda environment if they require dynamic resolution.*

### 4. Optional: Add it to Workspace Defaults
If you want the agent to automatically know about the skill and when to use it, update the default templates in `bridge/workspace-files.js`.

Find the `buildMainToolsDefault` function and add a descriptive bullet point about your new skill:

```javascript
    "## Runtime Tools",
    "",
    "- **my_new_skill** for fetching proprietary data",
```
This ensures that when a new user starts chatting, their `TOOLS.md` file is seeded with the knowledge that this skill exists.

---

## Final Step: Deployment
After making any of the above changes (adding to Dockerfile or agentcore-contract), you must rebuild the container image and deploy the stack:

```bash
source .venv/bin/activate
cdk deploy OpenClawAgentCore
```
