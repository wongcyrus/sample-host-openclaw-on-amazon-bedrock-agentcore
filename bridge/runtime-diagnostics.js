const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const runFile = promisify(execFile);

async function collectDiagnostics({
  limit = 500,
  checkMcp = false,
  env = process.env,
  gatewayEnv = env,
  readFile = fs.readFile,
  run = runFile,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error("limit must be an integer between 1 and 2000");
  }
  if (typeof checkMcp !== "boolean") throw new Error("checkMcp must be boolean");
  const config = JSON.parse(await readFile(
    path.join(env.HOME || "/root", ".openclaw", "openclaw.json"), "utf8",
  ));
  const expected = env.HUMANOID_MCP_SERVER_URL || "";
  const skills = Object.fromEntries(["humanoid", "digital_human"].map((name) => {
    const entry = config.skills?.entries?.[name];
    const url = entry?.env?.MCP_SERVER_URL || "";
    return [name, {
      enabled: entry?.enabled === true,
      url,
      authMode: entry?.env?.MCP_AUTH_MODE || "",
      matchesRuntime: url === expected,
    }];
  }));
  const { stdout, stderr } = await run(
    "openclaw",
    ["logs", "--limit", String(limit), "--max-bytes", "500000", "--json"],
    { env: gatewayEnv, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  const connection = checkMcp ? await run(
    "/skills/humanoid/run.sh", ["--check-connection"],
    { env: gatewayEnv, timeout: 60000, maxBuffer: 128 * 1024 },
  ) : null;
  return {
    expectedMcpUrl: expected,
    skills,
    extraDirs: config.skills?.load?.extraDirs || [],
    nativeLogs: stdout,
    nativeLogsStderr: stderr,
    mcpConnection: connection ? JSON.parse(connection.stdout) : null,
  };
}

module.exports = { collectDiagnostics };
