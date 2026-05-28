import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { recordRunResult } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import {
  journalPath,
  tempProject,
  appendConfigEntry,
  createFakePiExec,
} from "../helpers/research-fixture.mjs";

function fakeDeps(projectDir, state, overrides = {}) {
  const { calls, pi } = createFakePiExec({
    "git diff": () => ({ code: 1, stdout: "", stderr: "" }),
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
    ...overrides,
  };
}

test("run logging records a kept Run Result, commits workspace, and appends journal", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";

    const deps = fakeDeps(projectDir, state);
    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
      metrics: { compile_ms: 50 },
      asi: { hypothesis: "baseline" },
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(result.ok && result.runResult.commit, "abc1234");
    assert.equal(deps._calls.some(([command, args]) => command === "git" && args[0] === "commit"), true);
    const lines = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[1]);
    assert.equal(entry.description, "baseline");
    assert.equal(entry.commit, "abc1234");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging blocks keep when checks failed before mutating state", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    const state = createResearchState();

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "bad keep",
    }, fakeDeps(projectDir, state, {
      lastRunChecks: { pass: false, output: "nope", duration: 0.1 },
    }));

    assert.equal(result.ok, false);
    assert.equal(state.results.length, 0);
    assert.equal(fs.existsSync(journalPath(projectDir)), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging journals and restores a rejected Run Result while preserving ASI", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";

    const deps = fakeDeps(projectDir, state);
    const result = await recordRunResult({
      commit: "pending",
      metric: 120,
      status: "discard",
      description: "try cache",
      metrics: { compile_ms: 70 },
      asi: { hypothesis: "cache lookup", rollback_reason: "slower", next_action_hint: "try pooling" },
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(deps._calls.some(([command, args]) => command === "bash" && args[0] === "-c"), true);
    assert.equal(deps._calls.some(([command]) => command === "git"), false);
    const lines = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry = JSON.parse(lines[1]);
    assert.equal(entry.status, "discard");
    assert.deepEqual(entry.asi, {
      hypothesis: "cache lookup",
      rollback_reason: "slower",
      next_action_hint: "try pooling",
    });
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging rejects missing known secondary metrics before side effects", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";
    state.secondaryMetrics = [{ name: "compile_ms", unit: "ms" }];

    const deps = fakeDeps(projectDir, state);
    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "discard",
      description: "missing secondary",
      metrics: {},
    }, deps);

    assert.equal(result.ok, false);
    assert.match(result.text, /Missing secondary metrics: compile_ms/);
    assert.equal(state.results.length, 0);
    assert.deepEqual(deps._calls, []);
    const lines = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging blocks state mutation when journal append fails", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    fs.mkdirSync(journalPath(projectDir), { recursive: true });
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "discard",
      description: "journal fails",
      asi: { hypothesis: "journal failure path" },
    }, fakeDeps(projectDir, state));

    assert.equal(result.ok, false);
    assert.match(result.text, /Failed to write goal\.jsonl/);
    assert.equal(state.results.length, 0);
    assert.equal(state.bestMetric, null);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging preserves a kept Run Result when git commit fails", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "commit fails",
      asi: { hypothesis: "commit failure path" },
    }, fakeDeps(projectDir, state, {
      pi: {
        async exec(command, args) {
          if (command === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
          if (command === "git" && args[0] === "commit") return { code: 1, stdout: "", stderr: "no identity" };
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    }));

    assert.equal(result.ok, true);
    assert.match(result.text, /Git commit failed/);
    assert.equal(result.runResult.commit, "pending");
    assert.equal(state.results.length, 1);
    const entry = JSON.parse(fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n")[1]);
    assert.equal(entry.description, "commit fails");
    assert.equal(entry.commit, "pending");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
