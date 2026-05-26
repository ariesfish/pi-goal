import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { readLastRunResult } from "../../extensions/pi-goal/persistence/research-journal-reader.ts";
import { hydrateResearchStateFromJournal } from "../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { restoreActiveResearchRuntime } from "../../extensions/pi-goal/support/research-runtime-restore.ts";
import { activeResearch, selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { buildResearchSnapshot } from "../../extensions/pi-goal/domain/research-snapshot.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";

function journalPath(projectDir) {
  return activeResearch(projectDir).paths.journal;
}

test("research lifecycle selects a sanitized active research and creates its directory", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-lifecycle-"));
  try {
    const selected = selectActiveResearch(projectDir, "Bundle Size!");

    assert.equal(selected.id, "bundle-size");
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
    fs.writeFileSync(journalPath(projectDir), [
      '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"baseline","timestamp":1,"metrics":{"compile_ms":50}}',
      '{"run":2,"commit":"bbb2222","metric":90,"status":"keep","description":"faster","timestamp":2,"metrics":{"compile_ms":45}}',
    ].join("\n") + "\n");

    const state = createResearchState();
    assert.equal(hydrateResearchStateFromJournal(state, fs.readFileSync(journalPath(projectDir), "utf-8")), true);
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

test("research runtime restore prefers Research Journal over session history and syncs phase", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-lifecycle-"));
  try {
    selectActiveResearch(projectDir, "default");
    fs.writeFileSync(journalPath(projectDir), [
      '{"type":"config","name":"Journal","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"journal baseline","timestamp":1,"metrics":{}}',
    ].join("\n") + "\n");
    const runtime = createSessionRuntime();
    const staleState = createResearchState();
    staleState.name = "Session history";
    staleState.results.push({
      commit: "stale",
      metric: 1,
      metrics: {},
      status: "keep",
      description: "stale",
      timestamp: 1,
      experimentIndex: 0,
      confidence: null,
    });

    const result = restoreActiveResearchRuntime({
      runtime,
      workDir: projectDir,
      ctxCwd: projectDir,
      sessionBranch: [{
        type: "message",
        message: { role: "toolResult", toolName: "log_goal", details: { state: staleState } },
      }],
    });

    assert.equal(result.loadedFromJournal, true);
    assert.equal(runtime.state.name, "Journal");
    assert.equal(runtime.state.results[0].description, "journal baseline");
    assert.equal(runtime.loop.mode, true);
    assert.equal(runtime.loop.phase, "looping");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
