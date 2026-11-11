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
        baseline_metric: currentState.baselineMetric,
        best_metric: currentState.baselineMetric,
        run_count: currentState.results.length,
        goal: currentState.name ?? "",
      };
    },
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
    assert.equal(
      deps._calls.some(([command, args]) => command === "git" && args[0] !== "rev-parse"),
      false,
    );
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
    assert.equal(state.baselineMetric, null);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

for (const failure of ["add", "commit"]) {
  test(`run logging blocks a keep when git ${failure} fails`, async () => {
    const projectDir = tempProject("pi-goal-log");
    try {
      selectActiveResearch(projectDir, "default");
      appendConfigEntry(projectDir);
      const state = createResearchState();
      state.name = "Speed";
      state.metricName = "total_ms";
      state.metricUnit = "ms";
      const before = fs.readFileSync(journalPath(projectDir), "utf-8");
      let hooks = 0;
      const deps = fakeDeps(projectDir, state, {
        async fireHook() { hooks += 1; return null; },
        pi: {
          async exec(command, args) {
            if (command === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
            if (command === "git" && args[0] === failure) return { code: 1, stdout: "", stderr: "injected git failure" };
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      });
      const result = await recordRunResult({
        commit: "pending", metric: 100, status: "keep",
        description: "settlement fails", asi: { hypothesis: "commit failure path" },
      }, deps);

      assert.equal(result.ok, false);
      assert.match(result.text, /Git (add|commit)/);
      assert.match(result.text, /retry log_goal/);
      assert.doesNotMatch(result.text, /Logged #/);
      assert.equal(state.results.length, 0);
      assert.equal(state.baselineMetric, null);
      assert.equal(hooks, 0);
      assert.equal(fs.readFileSync(journalPath(projectDir), "utf-8"), before);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
}

test("a journal failure after a kept Run Result committed reports the landed commit", async () => {
  const projectDir = tempProject("pi-goal-log");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";
    // The journal becomes unwritable only after the candidate is committed.
    const journal = journalPath(projectDir);
    const brokenJournalAfterCommit = (pi) => ({
      async exec(command, args, options) {
        if (command === "git" && args[0] === "commit") {
          const result = await pi.exec(command, args, options);
          fs.rmSync(journal, { force: true });
          fs.mkdirSync(journal, { recursive: true });
          return result;
        }
        return pi.exec(command, args, options);
      },
    });
    const deps = fakeDeps(projectDir, state);
    deps.pi = brokenJournalAfterCommit(deps.pi);

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "commit lands, journal fails",
    }, deps);

    assert.equal(result.ok, false);
    assert.match(result.text, /Failed to write goal\.jsonl/);
    assert.match(result.text, /already committed as abc1234/);
    assert.match(result.text, /Re-run log_goal/);
    assert.deepEqual(result.workspace, { commit: "abc1234" });
    assert.equal(state.results.length, 0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
