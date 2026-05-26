import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { executeExperimentConfigWorkflow } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { activeResearch, selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";

function tempProject() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-experiment-config-"));
  selectActiveResearch(dir, "default");
  return dir;
}

function deps(workDir, runtime, overrides = {}) {
  return {
    pi: {
      async exec(command, args) {
        if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime,
    workDir,
    ctxCwd: workDir,
    kind: "init_goal",
    title: "Research initialized",
    async fireHook() { return null; },
    readLastRun() { return null; },
    buildResearchSnapshot(state) {
      return {
        metric_name: state.metricName,
        metric_unit: state.metricUnit,
        direction: state.bestDirection,
        baseline_metric: state.bestMetric,
        best_metric: state.bestMetric,
        run_count: state.results.length,
        goal: state.name ?? "",
      };
    },
    broadcastDashboardUpdate() {},
    ...overrides,
  };
}

test("experiment config workflow initializes Research and writes the first Experiment config", async () => {
  const workDir = tempProject();
  try {
    const runtime = createSessionRuntime();
    let broadcasted = false;
    const result = await executeExperimentConfigWorkflow({
      name: "Speed",
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
    }, deps(workDir, runtime, { broadcastDashboardUpdate() { broadcasted = true; } }));

    assert.equal(result.ok, true);
    assert.equal(runtime.state.name, "Speed");
    assert.equal(runtime.state.metricName, "total_ms");
    assert.equal(runtime.loop.phase, "needs_baseline");
    assert.equal(broadcasted, true);
    const lines = fs.readFileSync(activeResearch(workDir).paths.journal, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      type: "config",
      name: "Speed",
      metricName: "total_ms",
      metricUnit: "ms",
      bestDirection: "lower",
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("experiment config workflow rejects init_goal after the active Research has Run Results", async () => {
  const workDir = tempProject();
  try {
    const runtime = createSessionRuntime();
    runtime.state.results.push({
      commit: "abc1234",
      metric: 10,
      metrics: {},
      status: "keep",
      description: "baseline",
      timestamp: Date.now(),
      experimentIndex: 0,
      confidence: null,
    });

    const result = await executeExperimentConfigWorkflow({
      name: "Speed",
      metric_name: "total_ms",
      direction: "lower",
    }, deps(workDir, runtime));

    assert.equal(result.ok, false);
    assert.match(result.text, /first experiment only/);
    assert.equal(fs.existsSync(activeResearch(workDir).paths.journal), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("experiment config workflow starts a later Experiment and resets comparison state", async () => {
  const workDir = tempProject();
  try {
    const runtime = createSessionRuntime();
    runtime.state.name = "Speed";
    runtime.state.metricName = "total_ms";
    runtime.state.metricUnit = "ms";
    runtime.state.bestMetric = 10;
    runtime.state.secondaryMetrics = [{ name: "compile_ms", unit: "ms" }];
    runtime.state.confidence = 2;
    runtime.state.results.push({
      commit: "abc1234",
      metric: 10,
      metrics: { compile_ms: 3 },
      status: "keep",
      description: "baseline",
      timestamp: Date.now(),
      experimentIndex: 0,
      confidence: null,
    });
    fs.writeFileSync(activeResearch(workDir).paths.journal, '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}\n');

    const result = await executeExperimentConfigWorkflow({
      name: "Speed v2",
      metric_name: "p95_ms",
      metric_unit: "ms",
      direction: "lower",
    }, deps(workDir, runtime, { kind: "start_goal", title: "Experiment started" }));

    assert.equal(result.ok, true);
    assert.equal(runtime.state.currentExperimentIndex, 1);
    assert.equal(runtime.state.bestMetric, null);
    assert.deepEqual(runtime.state.secondaryMetrics, []);
    assert.equal(runtime.state.confidence, null);
    assert.match(result.text, /new experiment started/);
    const lines = fs.readFileSync(activeResearch(workDir).paths.journal, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).metricName, "p95_ms");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
