import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  activeResearch,
  ensureActiveResearch,
  sanitizeResearchId,
  selectActiveResearch,
} from "../../extensions/pi-goal/persistence/research-directory.ts";

test("Research Directory exposes active Research identity and paths", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-research-dir-"));
  try {
    const research = activeResearch(projectDir);

    assert.equal(research.id, "default");
    assert.equal(research.paths.directory, path.join(projectDir, ".goal", "researches", "default"));
    assert.equal(research.paths.journal, path.join(research.paths.directory, "goal.jsonl"));
    assert.equal(research.paths.rules, path.join(research.paths.directory, "goal.md"));
    assert.equal(research.paths.script, path.join(research.paths.directory, "goal.sh"));
    assert.equal(fs.existsSync(research.paths.directory), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("ensureActiveResearch creates the active file and active Research directory", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-research-dir-"));
  try {
    const research = ensureActiveResearch(projectDir);

    assert.equal(research.id, "default");
    assert.equal(fs.existsSync(research.paths.activeFile), true);
    assert.equal(fs.readFileSync(research.paths.activeFile, "utf-8"), "default\n");
    assert.equal(fs.statSync(research.paths.directory).isDirectory(), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("selectActiveResearch sanitizes identity and switches Active Research", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-research-dir-"));
  try {
    const selected = selectActiveResearch(projectDir, "Bundle Size!");

    assert.equal(selected.id, "bundle-size");
    assert.equal(sanitizeResearchId("Bundle Size!"), "bundle-size");
    assert.equal(activeResearch(projectDir).id, "bundle-size");
    assert.equal(activeResearch(projectDir).paths.directory, selected.paths.directory);
    assert.equal(fs.statSync(selected.paths.directory).isDirectory(), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
