/**
 * Workspace Sync — .openclaw/ directory persistence to/from S3.
 *
 * Restores a user's .openclaw/ directory from S3 on session start, and
 * periodically saves it back. Uses the same S3 bucket and client pattern
 * as the proxy's workspace files (readUserFileFromS3/writeUserFileToS3).
 *
 * Namespace format: {actorId.replace(/:/g, "_")} (e.g., "telegram_123456789")
 * S3 prefix: {namespace}/.openclaw/
 * Local path: $HOME/.openclaw/ (defaults to /root/.openclaw/)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash, randomUUID } = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { once } = require("events");
const { createWorkspaceSnapshot, listFiles, publishDirectorySnapshot } = require("./workspace-snapshot");
const {
  WORKSPACE_FILES,
  getWorkspaceDefaults,
  getManagedWorkspaceS3Candidates,
  buildAgentWorkspaceDir,
} = require("./workspace-files");

// Lazy-require AWS SDK (only available inside Docker image, not in local dev/test)
let _s3Sdk = null;
function getS3Sdk() {
  if (!_s3Sdk) {
    _s3Sdk = require("@aws-sdk/client-s3");
  }
  return _s3Sdk;
}

const BUCKET = process.env.S3_USER_FILES_BUCKET;
const LOCAL_PATH = process.env.HOME
  ? `${process.env.HOME}/.openclaw`
  : "/root/.openclaw";
const LOCAL_WORKSPACE_PATH = path.join(LOCAL_PATH, "workspace");
const LOCAL_WORKSPACES_ROOT = path.join(LOCAL_PATH, "workspaces");
const WORKSPACE_PREFIX = ".openclaw";
const SNAPSHOT_PREFIX = ".openclaw-snapshots";
const MANAGED_WORKSPACE_BOOTSTRAP_NAMESPACE = (
  process.env.MANAGED_WORKSPACE_BOOTSTRAP_NAMESPACE || ""
).trim();

// Skip patterns — files/dirs that should not be synced to S3
const SKIP_PATTERNS = [
  "node_modules/",
  ".cache/",
  "*.log",
  "*.lock",
  ".npm/",
  "package-lock.json",
  "openclaw.json",
  "AGENTS.md",
  "workspace/",
  "workspaces/",
  // Security: exclude files that commonly contain secrets
  ".env",
  ".secrets/",
  "*.pem",
  "*.key",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Credential patterns — detect potential secrets before S3 upload.
// Files matching these are still uploaded (user's choice) but a warning is logged.
// The designated native key store (user-api-keys.json) is exempt.
const CREDENTIAL_PATTERNS = [
  /AKIA[0-9A-Z]{16}/, // AWS access key IDs
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/, // Private keys
  /sk-[a-zA-Z0-9]{20,}/, // OpenAI / Anthropic keys
  /xox[bpas]-[a-zA-Z0-9-]{10,}/, // Slack tokens
  /\d{8,10}:[a-zA-Z0-9_-]{35}/, // Telegram bot tokens
  /ghp_[a-zA-Z0-9]{36}/, // GitHub personal access tokens
  /glpat-[a-zA-Z0-9_-]{20,}/, // GitLab personal access tokens
];
// File exempt from credential scanning — the designated native API key store.
// Users who choose "native" storage consciously store keys here.
const CREDENTIAL_SCAN_EXEMPT = "user-api-keys.json";

// S3 client singleton (same pattern as agentcore-proxy.js)
let _s3Client = null;
let _scopedCredentials = null;

function getS3Client() {
  if (!_s3Client) {
    const { S3Client } = getS3Sdk();
    const opts = { region: process.env.AWS_REGION };
    if (_scopedCredentials) {
      opts.credentials = {
        accessKeyId: _scopedCredentials.accessKeyId,
        secretAccessKey: _scopedCredentials.secretAccessKey,
        sessionToken: _scopedCredentials.sessionToken,
      };
    }
    _s3Client = new S3Client(opts);
  }
  return _s3Client;
}

/**
 * Configure the S3 client with explicit credentials (scoped STS session).
 * Replaces the default client that uses the container's execution role.
 *
 * @param {object} credentials
 * @param {string} credentials.accessKeyId
 * @param {string} credentials.secretAccessKey
 * @param {string} [credentials.sessionToken]
 */
function configureCredentials(credentials) {
  if (!credentials || !credentials.accessKeyId) {
    throw new Error("configureCredentials: accessKeyId is required");
  }
  if (!credentials.secretAccessKey) {
    throw new Error("configureCredentials: secretAccessKey is required");
  }
  _scopedCredentials = {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
  // Reset client so next getS3Client() picks up new credentials
  _s3Client = null;
}

/**
 * Scan file content for potential credentials/secrets.
 * Returns the name of the first matching pattern, or null if clean.
 *
 * @param {Buffer|string} content - File content to scan
 * @returns {string|null} - Pattern description if detected, null if clean
 */
function detectCredentials(content) {
  const text = typeof content === "string" ? content : content.toString("utf-8", 0, Math.min(content.length, 1024 * 64));
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source.slice(0, 40);
    }
  }
  return null;
}

/**
 * Check if a relative path matches any skip pattern.
 */
function shouldSkip(relativePath) {
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.endsWith("/")) {
      // Directory pattern
      if (
        relativePath.startsWith(pattern) ||
        relativePath.includes("/" + pattern)
      ) {
        return true;
      }
    } else if (pattern.startsWith("*")) {
      // Wildcard extension
      const ext = pattern.slice(1);
      if (relativePath.endsWith(ext)) return true;
    } else {
      if (relativePath === pattern || relativePath.endsWith("/" + pattern)) {
        return true;
      }
    }
  }
  return false;
}

function getWorkspaceDefaultOptions() {
  return {
    browserEnabled: Boolean(process.env.BROWSER_IDENTIFIER),
    humanoidEnabled: Boolean((process.env.HUMANOID_MCP_SERVER_URL || "").trim()),
  };
}

async function readManagedWorkspaceFile(namespace, agentId, filename) {
  const defaults = getWorkspaceDefaults(getWorkspaceDefaultOptions(), agentId);
  if (!BUCKET || !namespace) {
    return defaults[filename] || "";
  }

  for (const key of getManagedWorkspaceS3Candidates({
    namespace,
    bootstrapNamespace: MANAGED_WORKSPACE_BOOTSTRAP_NAMESPACE,
    agentId,
    filename,
  })) {
    try {
      const response = await getS3Client().send(
        new (getS3Sdk().GetObjectCommand)({
          Bucket: BUCKET,
          Key: key,
        }),
      );
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      if (
        MANAGED_WORKSPACE_BOOTSTRAP_NAMESPACE &&
        key.startsWith(`${MANAGED_WORKSPACE_BOOTSTRAP_NAMESPACE}/`)
      ) {
        console.log(
          `[workspace-sync] Using bootstrap managed workspace file: s3://${BUCKET}/${key}`,
        );
      }
      return Buffer.concat(chunks).toString("utf-8");
    } catch (err) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        continue;
      }
      throw err;
    }
  }
  return defaults[filename] || "";
}

async function syncManagedWorkspaceFiles(namespace, agentIds = ["main"]) {
  fs.mkdirSync(LOCAL_WORKSPACE_PATH, { recursive: true });
  fs.mkdirSync(LOCAL_WORKSPACES_ROOT, { recursive: true });

  let synced = 0;
  const homeDir = process.env.HOME || "/root";
  for (const agentId of agentIds) {
    const managedDir = buildAgentWorkspaceDir(homeDir, agentId);
    fs.mkdirSync(managedDir, { recursive: true });
    for (const wf of WORKSPACE_FILES) {
      const content = await readManagedWorkspaceFile(namespace, agentId, wf.filename);
      const localFile = path.join(managedDir, wf.filename);
      if (!content) {
        if (fs.existsSync(localFile)) {
          fs.rmSync(localFile, { force: true });
        }
        continue;
      }
      fs.writeFileSync(localFile, content, "utf-8");
      synced++;
    }
  }

  console.log(
    `[workspace-sync] Mirrored ${synced} managed workspace file(s) across ${agentIds.length} agent workspace(s)`,
  );
}

/**
 * Restore the .openclaw/ directory from S3 for a user namespace.
 * Downloads all objects under {namespace}/.openclaw/ to $HOME/.openclaw/.
 * Skips silently if no objects exist (new user).
 */
async function restoreLegacyWorkspace(namespace) {
  if (!BUCKET || !namespace) {
    console.log("[workspace-sync] No bucket or namespace — skipping restore");
    return;
  }

  const prefix = `${namespace}/${WORKSPACE_PREFIX}/`;
  const s3 = getS3Client();

  console.log(
    `[workspace-sync] Restoring workspace from s3://${BUCKET}/${prefix}`,
  );

  let totalFiles = 0;
  let continuationToken;

  do {
    const params = {
      Bucket: BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    };
    if (continuationToken) params.ContinuationToken = continuationToken;

    const response = await s3.send(new (getS3Sdk().ListObjectsV2Command)(params));
    const objects = response.Contents || [];

    for (const obj of objects) {
      const relativePath = obj.Key.slice(prefix.length);
      if (!relativePath || shouldSkip(relativePath)) continue;

      // Validate object size before downloading (uses ListObjectsV2 Size field)
      if (obj.Size > MAX_FILE_SIZE) {
        console.warn(
          `[workspace-sync] Skipping oversized file: ${obj.Key} (${obj.Size} bytes)`,
        );
        continue;
      }

      const localFile = path.join(LOCAL_PATH, relativePath);
      const localDir = path.dirname(localFile);

      // Path traversal protection: ensure resolved path stays within LOCAL_PATH
      const resolvedFile = path.resolve(localFile);
      const resolvedBase = path.resolve(LOCAL_PATH);
      if (
        !resolvedFile.startsWith(resolvedBase + path.sep) &&
        resolvedFile !== resolvedBase
      ) {
        console.warn(
          `[workspace-sync] Path traversal blocked: ${relativePath}`,
        );
        continue;
      }

      try {
        fs.mkdirSync(localDir, { recursive: true });
        const getResp = await s3.send(
          new (getS3Sdk().GetObjectCommand)({ Bucket: BUCKET, Key: obj.Key }),
        );
        const chunks = [];
        for await (const chunk of getResp.Body) {
          chunks.push(chunk);
        }
        fs.writeFileSync(localFile, Buffer.concat(chunks));
        totalFiles++;
      } catch (err) {
        throw new Error(`Failed to restore ${relativePath}: ${err.message}`, { cause: err });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`[workspace-sync] Restored ${totalFiles} file(s) to ${LOCAL_PATH}`);
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function validateSnapshotManifest(manifest) {
  if (manifest?.version !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.generation) ||
      !Array.isArray(manifest.files)) {
    throw new Error("Invalid workspace snapshot manifest");
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !file.path ||
        path.isAbsolute(file.path) || file.path.includes("\\") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..") ||
        shouldSkip(file.path) || seen.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid workspace snapshot file entry");
    }
    seen.add(file.path);
  }
}

async function restoreWorkspace(namespace) {
  if (!BUCKET || !namespace) return restoreLegacyWorkspace(namespace);
  const prefix = `${namespace}/${SNAPSHOT_PREFIX}/`;
  let response;
  try {
    response = await getS3Client().send(new (getS3Sdk().GetObjectCommand)({
      Bucket: BUCKET, Key: `${prefix}latest.json`,
    }));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return restoreLegacyWorkspace(namespace);
    }
    throw err;
  }
  const manifest = JSON.parse(await response.Body.transformToString());
  validateSnapshotManifest(manifest);
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restore-"));
  try {
    for (const file of manifest.files) {
      const destination = path.join(staged, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const object = await getS3Client().send(new (getS3Sdk().GetObjectCommand)({
        Bucket: BUCKET, Key: `${prefix}${manifest.generation}/${file.path}`,
      }));
      if (object.ContentLength !== file.size) {
        throw new Error(`Snapshot size mismatch: ${file.path}`);
      }
      await pipeline(Readable.from(object.Body), fs.createWriteStream(destination));
      if (fs.statSync(destination).size !== file.size || await hashFile(destination) !== file.sha256) {
        throw new Error(`Snapshot checksum mismatch: ${file.path}`);
      }
    }
    publishDirectorySnapshot(staged, LOCAL_PATH);
    console.log(`[workspace-sync] Restored committed snapshot ${manifest.generation} (${manifest.files.length} files)`);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
/**
 * Save the .openclaw/ directory to S3 for a user namespace.
 * Publish an immutable generation, then commit its checksum manifest last.
 * SQLite uses online backup; ordinary files retain the 10 MB limit.
 */
async function saveWorkspaceSnapshot(namespace) {
  if (!BUCKET || !namespace) return;

  const generation = randomUUID();
  const prefix = `${namespace}/${SNAPSHOT_PREFIX}/`;
  const s3 = getS3Client();
  const snapshot = await createWorkspaceSnapshot(LOCAL_PATH, { shouldSkip, includeSymlinks: false });
  const manifest = { version: 1, generation, createdAt: new Date().toISOString(), files: [] };
  try {
    for (const relativePath of listFiles(snapshot.path)) {
      const localFile = path.join(snapshot.path, relativePath);
      const stat = fs.statSync(localFile);
      if (stat.size > MAX_FILE_SIZE && !snapshot.sqliteFiles.has(relativePath)) {
        console.warn(
          `[workspace-sync] Skipping ${relativePath} (${stat.size} bytes > ${MAX_FILE_SIZE})`,
        );
        continue;
      }
      if (relativePath !== CREDENTIAL_SCAN_EXEMPT) {
        const fd = fs.openSync(localFile, "r");
        const content = Buffer.alloc(Math.min(stat.size, 64 * 1024));
        try {
          fs.readSync(fd, content, 0, content.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        const detected = detectCredentials(content);
        if (detected) {
          console.warn(
            `[workspace-sync] WARNING: Potential credential detected in ${relativePath} ` +
            `(pattern: ${detected}). File will still be uploaded to S3.`,
          );
        }
      }
      const sha256 = await hashFile(localFile);
      const body = fs.createReadStream(localFile);
      await once(body, "open");
      try {
        await s3.send(new (getS3Sdk().PutObjectCommand)({
          Bucket: BUCKET, Key: `${prefix}${generation}/${relativePath}`,
          Body: body, ContentLength: stat.size,
        }));
      } finally {
        body.destroy();
      }
      manifest.files.push({ path: relativePath, size: stat.size, sha256 });
    }
    await s3.send(new (getS3Sdk().PutObjectCommand)({
      Bucket: BUCKET,
      Key: `${prefix}latest.json`,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }));
    console.log(`[workspace-sync] Committed snapshot ${generation} (${manifest.files.length} files)`);
  } finally {
    snapshot.cleanup();
  }
}

let _savePromise = null;
function saveWorkspace(namespace) {
  if (!_savePromise) {
    _savePromise = saveWorkspaceSnapshot(namespace).finally(() => { _savePromise = null; });
  }
  return _savePromise;
}

// Periodic save state
let _saveInterval = null;
// Backup mode: when session storage is primary, S3 sync becomes a cold backup
let _backupMode = false;
// Backup interval: 30 minutes (vs 5 minutes for primary sync)
const BACKUP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Enable or disable backup mode.
 * In backup mode, periodic saves use a longer interval (30 min)
 * since session storage handles primary persistence.
 */
function setBackupMode(enabled) {
  _backupMode = enabled;
  console.log(`[workspace-sync] Backup mode ${enabled ? "enabled" : "disabled"} (session storage is ${enabled ? "primary" : "unavailable"})`);
}

/**
 * Start periodic workspace saves.
 */
function startPeriodicSave(namespace, intervalMs) {
  const defaultInterval = parseInt(process.env.WORKSPACE_SYNC_INTERVAL_MS || "300000", 10);
  const interval = intervalMs || (_backupMode ? BACKUP_INTERVAL_MS : defaultInterval);
  if (_saveInterval) clearInterval(_saveInterval);

  _saveInterval = setInterval(() => {
    saveWorkspace(namespace).catch((err) => {
      console.warn(`[workspace-sync] Periodic save failed: ${err.message}`);
    });
  }, interval);

  console.log(
    `[workspace-sync] Periodic save started (every ${interval / 1000}s, mode=${_backupMode ? "backup" : "primary"})`,
  );
}

/**
 * Stop periodic saves and do a final save.
 */
function stopPeriodicSave() {
  if (_saveInterval) {
    clearInterval(_saveInterval);
    _saveInterval = null;
  }
}

async function cleanup(namespace) {
  stopPeriodicSave();
  if (namespace) {
    console.log("[workspace-sync] Final save before shutdown...");
    if (_savePromise) await _savePromise;
    await saveWorkspace(namespace);
  }
}

module.exports = {
  restoreWorkspace,
  saveWorkspace,
  syncManagedWorkspaceFiles,
  startPeriodicSave,
  stopPeriodicSave,
  cleanup,
  configureCredentials,
  setBackupMode,
  getS3Client,
  // Exported for testing
  shouldSkip,
  detectCredentials,
  CREDENTIAL_SCAN_EXEMPT,
  validateSnapshotManifest,
};
