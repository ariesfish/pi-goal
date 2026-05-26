import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { buildResearchSnapshot } from "../../extensions/pi-goal/domain/research-snapshot.ts";
import { buildResearchSummaryFromState } from "../../extensions/pi-goal/domain/research-summary.ts";
import { researchStateFromJournal } from "../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { activeResearch, selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import {
  executeExperimentConfigWorkflow,
  executeRunExperimentWorkflow,
  recordRunResult,
} from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";

import {
  createFakePiExec,
  createRuntimeWithMetric,
  journalPath,
  readJournalEntries,
  writeConfigEntry,
  appendRunEntry,
  withTempResearch,
} from "../helpers/research-fixture.mjs";

function configDeps(workDir, runtime, overrides = {}) {
  return {
    pi: createFakePiExec().pi,
    runtime,
    workDir,
    ctxCwd: workDir,
    kind: "init_goal",
    title: "Research initialized",
    async fireHook() { return null; },
    readLastRun() { return null; },
    buildResearchSnapshot,
    broadcastDashboardUpdate() {},
    ...overrides,
  };
}

function logDeps(workDir, runtime, overrides = {}) {
  return {
    pi: createFakePiExec().pi,
    workDir,
    state: runtime.state,
    lastRunChecks: runtime.lastRunChecks,
    wallClockSeconds: runtime.lastRunDuration,
    async fireHook() { return null; },
    buildResearchSnapshot,
    broadcastDashboardUpdate() {},
    ...overrides,
  };
}

test("Research can be initialized, measured, logged, hydrated, and summarized through public workflows", async () => {
  await withTempResearch("workflow-main", async (workDir) => {
    const runtime = createSessionRuntime();

    const init = await executeExperimentConfigWorkflow({
      name: "Speed",
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
    }, configDeps(workDir, runtime));
    assert.equal(init.ok, true);

    const run = await executeRunExperimentWorkflow(
      { command: "printf 'METRIC total_ms=100\\nMETRIC compile_ms=40\\n'" },
      { pi: createFakePiExec().pi, workDir, runtime, onActiveRunChange() {} },
    );
    assert.equal(run.ok, true);
    assert.equal(run.details.parsedPrimary, 100);

    const log = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
      metrics: { compile_ms: 40 },
      asi: { hypothesis: "baseline" },
    }, logDeps(workDir, runtime));
    assert.equal(log.ok, true);

    const hydrated = researchStateFromJournal(fs.readFileSync(journalPath(workDir), "utf-8"));
    const summary = buildResearchSummaryFromState(hydrated);

    assert.equal(summary.name, "Speed");
    assert.equal(summary.totalRunCount, 1);
    assert.equal(summary.currentExperiment.baseline?.metric, 100);
    assert.equal(summary.currentExperiment.best?.metric, 100);
    assert.deepEqual(summary.currentExperiment.baselineSecondary, { compile_ms: 40 });
  });
});

test("start_goal opens a new Experiment whose baseline and best are isolated from previous runs", async () => {
  await withTempResearch("workflow-start-goal", async (workDir) => {
    const runtime = createRuntimeWithMetric();
    runtime.state.bestMetric = 100;
    runtime.state.results.push(
      {
        commit: "aaa1111",
        metric: 100,
        metrics: { compile_ms: 40 },
        status: "keep",
        description: "old baseline",
        timestamp: 1,
        experimentIndex: 0,
        confidence: null,
      },
      {
        commit: "bbb2222",
        metric: 90,
        metrics: { compile_ms: 35 },
        status: "keep",
        description: "old best",
        timestamp: 2,
        experimentIndex: 0,
        confidence: null,
      },
    );
    writeConfigEntry(workDir, { name: "Speed", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" });
    appendRunEntry(workDir, {
      run: 1,
      commit: "aaa1111",
      metric: 100,
      metrics: { compile_ms: 40 },
      description: "old baseline",
      timestamp: 1,
    });
    appendRunEntry(workDir, {
      run: 2,
      commit: "bbb2222",
      metric: 90,
      metrics: { compile_ms: 35 },
      description: "old best",
      timestamp: 2,
    });

    const started = await executeExperimentConfigWorkflow({
      name: "Speed p95",
      metric_name: "p95_ms",
      metric_unit: "ms",
      direction: "lower",
    }, configDeps(workDir, runtime, { kind: "start_goal", title: "Experiment started" }));
    assert.equal(started.ok, true);

    const logged = await recordRunResult({
      commit: "pending",
      metric: 120,
      status: "keep",
      description: "new baseline",
      metrics: { render_ms: 12 },
      asi: { hypothesis: "new workload" },
    }, logDeps(workDir, runtime));
    assert.equal(logged.ok, true);

    const summary = buildResearchSummaryFromState(
      researchStateFromJournal(fs.readFileSync(activeResearch(workDir).paths.journal, "utf-8")),
    );
    assert.equal(summary.currentExperimentIndex, 1);
    assert.equal(summary.currentExperiment.runCount, 1);
    assert.equal(summary.currentExperiment.baseline?.description, "new baseline");
    assert.equal(summary.currentExperiment.best?.metric, 120);
    assert.deepEqual(summary.currentExperiment.runs.map((run) => run.experimentIndex), [1]);
  });
});

test("Active Research selection keeps separate journals and summaries for different Research identities", async () => {
  await withTempResearch("workflow-multi-research", async (workDir) => {
    selectActiveResearch(workDir, "Test Runtime");
    const runtimeA = createSessionRuntime();
    assert.equal((await executeExperimentConfigWorkflow({
      name: "Test Runtime",
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
    }, configDeps(workDir, runtimeA))).ok, true);
    assert.equal((await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "test baseline",
    }, logDeps(workDir, runtimeA))).ok, true);
    const journalA = activeResearch(workDir).paths.journal;

    selectActiveResearch(workDir, "Bundle Size");
    const runtimeB = createSessionRuntime();
    assert.equal((await executeExperimentConfigWorkflow({
      name: "Bundle Size",
      metric_name: "bundle_kb",
      metric_unit: "kb",
      direction: "lower",
    }, configDeps(workDir, runtimeB))).ok, true);
    assert.equal((await recordRunResult({
      commit: "pending",
      metric: 250,
      status: "keep",
      description: "bundle baseline",
    }, logDeps(workDir, runtimeB))).ok, true);
    const journalB = activeResearch(workDir).paths.journal;

    assert.notEqual(journalA, journalB);
    selectActiveResearch(workDir, "Test Runtime");
    const summaryA = buildResearchSummaryFromState(
      researchStateFromJournal(fs.readFileSync(activeResearch(workDir).paths.journal, "utf-8")),
    );
    selectActiveResearch(workDir, "Bundle Size");
    const summaryB = buildResearchSummaryFromState(
      researchStateFromJournal(fs.readFileSync(activeResearch(workDir).paths.journal, "utf-8")),
    );

    assert.equal(summaryA.metricName, "total_ms");
    assert.equal(summaryA.currentExperiment.baseline?.description, "test baseline");
    assert.equal(summaryB.metricName, "bundle_kb");
    assert.equal(summaryB.currentExperiment.baseline?.description, "bundle baseline");
    assert.equal(readJournalEntries(workDir).length, 2);
  });
});
