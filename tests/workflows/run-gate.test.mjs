import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { recordRunResult } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import {
  createFakePiExec,
  journalPath,
  tempProject,
} from "../helpers/research-fixture.mjs";

const contract = (criteria) => ({
  version: 1,
  objective: "cut test time",
  criteria,
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
});

const metricCriterion = {
  id: "C1",
  statement: "suite faster",
  kind: "metric",
  blocking: true,
  metric: { name: "total_ms", direction: "lower" },
};

const commandCriterion = {
  id: "C2",
  statement: "check passes",
  kind: "command",
  blocking: true,
  check: { command: "check", expect: "exit0" },
};

function fakeDeps(projectDir, state, execHandler = {}) {
  const { calls, pi } = createFakePiExec({
    "git diff": () => ({ code: 1, stdout: "", stderr: "" }),
    ...execHandler,
  });
  return {
    _calls: calls,
    pi,
    workDir: projectDir,
    state,
    lastRunChecks: null,
    wallClockSeconds: 1.2,
    async fireHook() { return null; },
    buildResearchSnapshot(currentState) {
      return {
        metric_name: currentState.metricName,
        metric_unit: currentState.metricUnit,
        direction: currentState.bestDirection,
        baseline_metric: currentState.bestMetric,
        best_metric: currentState.bestMetric,
        run_count: currentState.results.length,
        goal: currentState.name ?? "",
      };
    },
    broadcastDashboardUpdate() {},
  };
}

function newState() {
  const state = createResearchState();
  state.name = "Speed";
  state.metricName = "total_ms";
  state.metricUnit = "ms";
  state.bestDirection = "lower";
  return state;
}

test("a failing criterion blocks a keep before any state mutation or commit", async () => {
  const projectDir = tempProject("pi-goal-gate");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    state.contract = contract([commandCriterion]);
    const deps = fakeDeps(projectDir, state, {
      "bash -c": () => ({ code: 1, stdout: "nope", stderr: "" }),
    });

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "should not land",
    }, deps);

    assert.equal(result.ok, false);
    assert.match(result.text, /Gate failed/);
    assert.equal(state.results.length, 0);
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].verdict, "fail");
    assert.equal(deps._calls.some(([command, args]) => command === "git" && args[0] === "commit"), false);

    const entries = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "gate");
    assert.equal(entries[0].gate.verdict, "fail");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("an all-green gate allows the keep and journals the verdict", async () => {
  const projectDir = tempProject("pi-goal-gate");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    state.contract = contract([metricCriterion, commandCriterion]);
    const deps = fakeDeps(projectDir, state);

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].verdict, "pass");

    const entries = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries[0].type, "gate");
    assert.equal(entries[0].gate.verdict, "pass");
    assert.equal(entries[1].metric, 100);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a metric regression blocks a keep", async () => {
  const projectDir = tempProject("pi-goal-gate");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    state.contract = contract([metricCriterion]);
    state.results = [{
      commit: "abc1234",
      metric: 100,
      metrics: {},
      status: "keep",
      description: "baseline",
      timestamp: 1,
      experimentIndex: 0,
      confidence: null,
    }];
    const deps = fakeDeps(projectDir, state);

    const result = await recordRunResult({
      commit: "pending",
      metric: 130,
      status: "keep",
      description: "slower",
    }, deps);

    assert.equal(result.ok, false);
    assert.match(result.text, /C1/);
    assert.equal(state.results.length, 1);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("discards bypass the gate", async () => {
  const projectDir = tempProject("pi-goal-gate");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    state.contract = contract([commandCriterion]);
    const deps = fakeDeps(projectDir, state, {
      "bash -c": () => ({ code: 1, stdout: "", stderr: "" }),
    });

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "discard",
      description: "no good",
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(state.results[0].status, "discard");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
