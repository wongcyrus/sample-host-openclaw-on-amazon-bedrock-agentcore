const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  createWorkspaceSnapshot,
  publishDirectorySnapshot,
  recoverDirectorySnapshot,
} = require("./workspace-snapshot");

function python(script, ...args) {
  const result = spawnSync("python3", ["-c", script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe("workspace SQLite snapshots", () => {
  it("validates schemas using the same SQLite engine as OpenClaw", async () => {
    const { DatabaseSync } = require("node:sqlite");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
    let snapshot;
    try {
      const database = path.join(root, "state.sqlite");
      const writer = new DatabaseSync(database);
      try {
        writer.exec("CREATE TABLE messages (text TEXT CHECK (octet_length(text) > 0))");
        writer.prepare("INSERT INTO messages VALUES (?)").run("\u00e9");
      } finally {
        writer.close();
      }
      snapshot = await createWorkspaceSnapshot(root);
      const reader = new DatabaseSync(path.join(snapshot.path, "state.sqlite"), { readOnly: true });
      try {
        assert.equal(reader.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(reader.prepare("SELECT octet_length(text) AS bytes FROM messages").get().bytes, 2);
      } finally {
        reader.close();
      }
    } finally {
      snapshot?.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes committed WAL data but excludes uncommitted writes and sidecars", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
    let snapshot;
    try {
      const database = path.join(root, "state.sqlite");
      python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE messages (text)")
db.execute("INSERT INTO messages VALUES ('committed')")
db.commit()
db.execute("INSERT INTO messages VALUES ('uncommitted')")
# Exit without close/checkpoint to leave the committed record in the WAL.
import os
os._exit(0)
`, database);
      assert.ok(fs.existsSync(`${database}-wal`));
      fs.writeFileSync(path.join(root, "notes.md"), "saved");
      snapshot = await createWorkspaceSnapshot(root);
      assert.ok(snapshot.sqliteFiles.has("state.sqlite"));
      assert.ok(!fs.existsSync(path.join(snapshot.path, "state.sqlite-wal")));
      assert.equal(python(`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert db.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
print(db.execute("SELECT text FROM messages").fetchall())
`, path.join(snapshot.path, "state.sqlite")), "[('committed',)]");
      assert.equal(fs.readFileSync(path.join(snapshot.path, "notes.md"), "utf8"), "saved");
    } finally {
      snapshot?.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on corrupt databases without publishing a replacement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
    try {
      fs.writeFileSync(path.join(root, "state.sqlite"), "not a database");
      await assert.rejects(createWorkspaceSnapshot(root), /SQLite snapshot failed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the previous generation and recovers an interrupted directory handover", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "workspace");
      fs.mkdirSync(source);
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(source, "notes"), "new");
      fs.writeFileSync(path.join(destination, "notes"), "old");
      publishDirectorySnapshot(source, destination);
      assert.equal(fs.readFileSync(path.join(destination, "notes"), "utf8"), "new");
      assert.equal(fs.readFileSync(path.join(`${destination}.previous`, "notes"), "utf8"), "old");
      fs.renameSync(destination, `${destination}.interrupted`);
      recoverDirectorySnapshot(destination);
      assert.equal(fs.readFileSync(path.join(destination, "notes"), "utf8"), "old");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves session-storage symlinks without following them into external files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
    let snapshot;
    try {
      fs.symlinkSync("/outside-workspace/private", path.join(root, "external-link"));
      snapshot = await createWorkspaceSnapshot(root);
      assert.equal(fs.readlinkSync(path.join(snapshot.path, "external-link")), "/outside-workspace/private");
      snapshot.cleanup();
      snapshot = await createWorkspaceSnapshot(root, { includeSymlinks: false });
      assert.deepEqual(fs.readdirSync(snapshot.path), []);
    } finally {
      snapshot?.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const code of ["EXDEV", "EBUSY"]) {
    it(`publishes and recovers in place when the workspace root cannot be renamed (${code})`, (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
      const source = path.join(root, "source");
      const destination = path.join(root, "workspace");
      const rename = fs.renameSync;
      const copy = fs.cpSync;
      try {
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(source, "notes"), "new");
        fs.writeFileSync(path.join(destination, "notes"), "old");
        t.mock.method(fs, "renameSync", (from, to) => {
          if (from === destination) throw Object.assign(new Error("Directory is a filesystem boundary"), { code });
          return rename(from, to);
        });
        publishDirectorySnapshot(source, destination);
        assert.equal(fs.readFileSync(path.join(destination, "notes"), "utf8"), "new");
        assert.equal(fs.readFileSync(path.join(`${destination}.previous`, "notes"), "utf8"), "old");
        assert.ok(!fs.existsSync(`${destination}.publish-pending`));

        fs.writeFileSync(path.join(source, "notes"), "interrupted");
        t.mock.method(fs, "cpSync", (from, to, options) => {
          if (to === path.join(destination, "notes")) throw new Error("Interrupted publication");
          return copy(from, to, options);
        });
        assert.throws(() => publishDirectorySnapshot(source, destination), /Interrupted publication/);
        assert.ok(fs.existsSync(`${destination}.publish-pending`));
        t.mock.restoreAll();
        recoverDirectorySnapshot(destination);
        assert.equal(fs.readFileSync(path.join(destination, "notes"), "utf8"), "new");
        assert.ok(!fs.existsSync(`${destination}.publish-pending`));
      } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
