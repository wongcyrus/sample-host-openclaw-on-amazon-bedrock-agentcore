const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const runFile = promisify(execFile);

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const SQLITE_BACKUP_SCRIPT = `
const { DatabaseSync, backup } = require("node:sqlite");
const deadline = Date.now() + 20000;
(async () => {
  for (const [source, destination] of JSON.parse(process.argv[1])) {
    const reader = new DatabaseSync(source, { readOnly: true, timeout: 2000 });
    try {
      await backup(reader, destination, {
        rate: 256,
        progress() {
          if (Date.now() > deadline) throw new Error("SQLite snapshot deadline exceeded");
        },
      });
    } finally {
      reader.close();
    }
    const writer = new DatabaseSync(destination);
    try {
      writer.exec("PRAGMA journal_mode=DELETE");
      const result = writer.prepare("PRAGMA integrity_check").all();
      if (result.length !== 1 || result[0].integrity_check !== "ok") {
        throw new Error("SQLite snapshot integrity check failed: " + JSON.stringify(result));
      }
    } finally {
      writer.close();
    }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;

function listFiles(root, relativeDir = "", includeSymlinks = false) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath, includeSymlinks));
    } else if (entry.isFile() || (includeSymlinks && entry.isSymbolicLink())) {
      files.push(relativePath);
    }
  }
  return files;
}

function isSQLiteDatabase(filename) {
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = fs.openSync(filename, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.equals(SQLITE_HEADER) || /\.(sqlite3?|db)$/i.test(filename);
}

async function createWorkspaceSnapshot(root, { shouldSkip = () => false, includeSymlinks = true } = {}) {
  const snapshotPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-"));
  const cleanup = () => fs.rmSync(snapshotPath, { recursive: true, force: true });
  try {
    const sourceFiles = listFiles(root, "", includeSymlinks);
    const files = sourceFiles.filter((file) => !shouldSkip(file) && !file.endsWith(".lock"));
    const sqliteFiles = new Set(
      files.filter((file) => !fs.lstatSync(path.join(root, file)).isSymbolicLink() &&
        isSQLiteDatabase(path.join(root, file))),
    );
    const sqliteSources = new Set(
      sourceFiles.filter((file) => /-(wal|shm|journal)$/.test(file))
        .map((file) => file.replace(/-(wal|shm|journal)$/, "")),
    );
    for (const source of sqliteSources) {
      if (!sqliteFiles.has(source) && !shouldSkip(source)) {
        throw new Error(`SQLite sidecar has no database in snapshot: ${source}`);
      }
    }

    const databases = [];
    for (const file of files) {
      if (/-(wal|shm|journal)$/.test(file) && sqliteFiles.has(file.replace(/-(wal|shm|journal)$/, ""))) {
        continue;
      }
      const source = path.join(root, file);
      const destination = path.join(snapshotPath, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.lstatSync(source).isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(source), destination);
      } else if (sqliteFiles.has(file)) {
        databases.push([source, destination]);
      } else {
        fs.copyFileSync(source, destination);
      }
    }
    if (databases.length) {
      try {
        await runFile(process.execPath, ["-e", SQLITE_BACKUP_SCRIPT, JSON.stringify(databases)], {
          encoding: "utf8",
          timeout: 25000,
        });
      } catch (err) {
        throw new Error(`SQLite snapshot failed: ${err.stderr?.trim() || err.message}`, { cause: err });
      }
    }
    return { path: snapshotPath, sqliteFiles, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function publishDirectorySnapshot(source, destination) {
  recoverDirectorySnapshot(destination);
  const previous = `${destination}.previous`;
  const staged = `${destination}.next`;
  const pending = `${destination}.publish-pending`;
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (fs.existsSync(destination)) {
    fs.rmSync(previous, { recursive: true, force: true });
    try {
      fs.renameSync(destination, previous);
    } catch (err) {
      if (err.code !== "EXDEV" && err.code !== "EBUSY") throw err;
      console.warn("[workspace-snapshot] Directory rename unavailable; using journaled in-place publication");
      fs.cpSync(destination, previous, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      fs.writeFileSync(pending, "pending\n", { flag: "wx" });
      replaceDirectoryContents(staged, destination);
      fs.unlinkSync(pending);
      fs.rmSync(staged, { recursive: true, force: true });
      return;
    }
  }
  fs.renameSync(staged, destination);
}

function replaceDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

function recoverDirectorySnapshot(destination) {
  const pending = `${destination}.publish-pending`;
  if (fs.existsSync(pending)) {
    if (!fs.existsSync(`${destination}.previous`)) {
      throw new Error(`Cannot recover interrupted workspace publication: ${destination}`);
    }
    replaceDirectoryContents(`${destination}.previous`, destination);
    fs.unlinkSync(pending);
    return;
  }
  if (!fs.existsSync(destination) && fs.existsSync(`${destination}.previous`)) {
    fs.renameSync(`${destination}.previous`, destination);
  }
}

module.exports = {
  createWorkspaceSnapshot,
  publishDirectorySnapshot,
  recoverDirectorySnapshot,
  listFiles,
};
