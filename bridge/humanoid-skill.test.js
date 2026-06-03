const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

describe("humanoid skill", () => {
  it("lists available actions as JSON without requiring runtime env", () => {
    const scriptPath = path.join(
      __dirname,
      "skills",
      "humanoid",
      "scripts",
      "skill.py",
    );
    const output = execFileSync("python3", [scriptPath, "--list-actions"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);

    assert.equal(typeof parsed.total_actions, "number");
    assert.ok(parsed.total_actions > 1);
    assert.equal(parsed.categories.gesture.wave, "3.5s");
    assert.equal(parsed.categories.image.capture_image, "~15s");
  });

  it("still lists actions when api-key mode is selected", () => {
    const scriptPath = path.join(
      __dirname,
      "skills",
      "humanoid",
      "scripts",
      "skill.py",
    );
    const output = execFileSync(
      "python3",
      [scriptPath, "--list-actions", "--auth-mode", "api-key"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output);

    assert.equal(parsed.categories.control.stop, "0s");
  });
});
