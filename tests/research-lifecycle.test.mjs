import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  buildResearchSnapshot,
  hydrateResearchStateFromJournal,
  readLastRunResult,
  selectActiveResearch,
} from "../extensions/pi-goal/persistence/research-store.ts";
import { researchJournalPath } from "../extensions/pi-goal/persistence/research-paths.ts";
import { createResearchState } from "../extensions/pi-goal/domain/research-state.ts";

test("research lifecycle selects a sanitized active research and creates its directory", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-lifecycle-"));
  try {
    const selected = selectActiveResearch(projectDir, "Bundle Size!");

    assert.equal(selected, "bundle-size");
    assert.equal(fs.readFileSync(path.join(projectDir, ".goal", "active"), "utf-8"), "bundle-size\n");
    assert.equal(fs.existsSync(path.join(projectDir, ".goal", "researches", "bundle-size")), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("research lifecycle hydrates state and reads the latest Run Result", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-lifecycle-"));
  try {
    selectActiveResearch(projectDir, "default");
    fs.writeFileSync(researchJournalPath(projectDir), [
      '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"baseline","timestamp":1,"metrics":{"compile_ms":50}}',
      '{"run":2,"commit":"bbb2222","metric":90,"status":"keep","description":"faster","timestamp":2,"metrics":{"compile_ms":45}}',
    ].join("\n") + "\n");

    const state = createResearchState();
    assert.equal(hydrateResearchStateFromJournal(state, fs.readFileSync(researchJournalPath(projectDir), "utf-8")), true);
    assert.equal(state.name, "Speed");
    assert.equal(state.bestMetric, 100);
    assert.equal(state.results.length, 2);
    assert.equal(readLastRunResult(projectDir)?.description, "faster");

    assert.deepEqual(buildResearchSnapshot(state), {
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
      baseline_metric: 100,
      best_metric: 90,
      run_count: 2,
      goal: "Speed",
    });
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
