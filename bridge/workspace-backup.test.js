const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");

describe("committed workspace backups", () => {
  let home, sync, objects, uploads, previousEnv;
  beforeEach(() => {
    previousEnv = { HOME: process.env.HOME, S3_USER_FILES_BUCKET: process.env.S3_USER_FILES_BUCKET };
    home = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-backup-test-"));
    process.env.HOME = home;
    process.env.S3_USER_FILES_BUCKET = "test-bucket";
    fs.mkdirSync(path.join(home, ".openclaw"));
    delete require.cache[require.resolve("./workspace-sync")];
    sync = require("./workspace-sync");
    objects = new Map();
    uploads = [];
    sync.getS3Client().send = async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        const chunks = [];
        if (typeof Body === "string") chunks.push(Buffer.from(Body));
        else for await (const chunk of Body) chunks.push(Buffer.from(chunk));
        objects.set(Key, Buffer.concat(chunks));
        uploads.push(Key);
        return {};
      }
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: [] };
      if (!objects.has(Key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      const content = objects.get(Key);
      const stream = Readable.from([content]);
      stream.transformToString = async () => content.toString();
      return { Body: stream, ContentLength: content.length };
    };
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve("./workspace-sync")];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("publishes the manifest last and restores only the committed generation", async () => {
    const filename = path.join(home, ".openclaw/notes.md");
    fs.writeFileSync(filename, "original");
    await sync.saveWorkspace("user_1");
    assert.equal(uploads.at(-1), "user_1/.openclaw-snapshots/latest.json");
    fs.writeFileSync(filename, "changed");
    objects.set("user_1/.openclaw-snapshots/uncommitted/notes.md", Buffer.from("partial"));
    await sync.restoreWorkspace("user_1");
    assert.equal(fs.readFileSync(filename, "utf8"), "original");
  });

  it("does not replace the manifest when an upload fails", async () => {
    fs.writeFileSync(path.join(home, ".openclaw/notes.md"), "original");
    await sync.saveWorkspace("user_1");
    const key = "user_1/.openclaw-snapshots/latest.json";
    const original = objects.get(key);
    sync.getS3Client().send = async () => { throw new Error("upload failed"); };
    await assert.rejects(sync.saveWorkspace("user_1"), /upload failed/);
    assert.deepEqual(objects.get(key), original);
  });

  it("fails a corrupt restore without overwriting local state", async () => {
    const filename = path.join(home, ".openclaw/notes.md");
    fs.writeFileSync(filename, "original");
    await sync.saveWorkspace("user_1");
    const manifest = JSON.parse(objects.get("user_1/.openclaw-snapshots/latest.json"));
    objects.set(`user_1/.openclaw-snapshots/${manifest.generation}/notes.md`, Buffer.from("tampered"));
    fs.writeFileSync(filename, "local");
    await assert.rejects(sync.restoreWorkspace("user_1"), /checksum mismatch/);
    assert.equal(fs.readFileSync(filename, "utf8"), "local");
  });

  it("backs up and restores SQLite databases larger than the ordinary 10 MB file limit", async () => {
    const filename = path.join(home, ".openclaw/state.sqlite");
    const result = spawnSync("python3", ["-c", `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("CREATE TABLE data (payload)")
    db.execute("INSERT INTO data VALUES (zeroblob(11 * 1024 * 1024))")
`, filename], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await sync.saveWorkspace("user_1");
    const manifest = JSON.parse(objects.get("user_1/.openclaw-snapshots/latest.json"));
    assert.ok(manifest.files.find((file) => file.path === "state.sqlite").size > 10 * 1024 * 1024);
    fs.rmSync(filename);
    await sync.restoreWorkspace("user_1");
    const check = spawnSync("python3", ["-c", `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert db.execute("SELECT length(payload) FROM data").fetchone()[0] == 11 * 1024 * 1024
`, filename], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  });

  it("rejects traversal, duplicate paths and excluded config in manifests", () => {
    const entry = { size: 1, sha256: "a".repeat(64) };
    const base = { version: 1, generation: "12345678-1234-1234-1234-123456789abc" };
    for (const filename of ["../escape", "/absolute", "a/../b", "openclaw.json"]) {
      assert.throws(() => sync.validateSnapshotManifest({ ...base, files: [{ ...entry, path: filename }] }));
    }
    assert.throws(() => sync.validateSnapshotManifest({
      ...base, files: [{ ...entry, path: "notes" }, { ...entry, path: "notes" }],
    }));
  });
});
