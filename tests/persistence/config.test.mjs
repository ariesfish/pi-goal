import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { readConfig, resolveWorkDir, validateWorkDir } from "../../extensions/pi-goal/persistence/goal-config.ts";

test("readConfig reports malformed config instead of silently falling back", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-config-"));
  try {
    fs.writeFileSync(path.join(dir, "goal.config.json"), "{ not json");
    const result = readConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.error, /Could not parse goal\.config\.json/);
    assert.match(validateWorkDir(dir), /Could not parse goal\.config\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkDir resolves relative workingDir against context cwd", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-config-"));
  try {
    fs.mkdirSync(path.join(dir, "bench"));
    fs.writeFileSync(path.join(dir, "goal.config.json"), JSON.stringify({ workingDir: "bench", maxIterations: 3 }));
    assert.equal(resolveWorkDir(dir), path.join(dir, "bench"));
    assert.equal(validateWorkDir(dir), null);
    assert.deepEqual(readConfig(dir), {
      ok: true,
      config: { workingDir: "bench", maxIterations: 3 },
      error: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
