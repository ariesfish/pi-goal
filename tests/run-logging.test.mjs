import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { recordRunResult } from "../extensions/pi-goal/run-result-workflow.ts";
import { selectActiveResearch } from "../extensions/pi-goal/persistence/research-store.ts";
import { researchJournalPath } from "../extensions/pi-goal/persistence/research-paths.ts";
import { createResearchState } from "../extensions/pi-goal/domain/research-state.ts";

function fakeDeps(projectDir, state, execCalls = []) {
  return {
    pi: {
      async exec(command, args) {
        execCalls.push([command, args]);
        if (command === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "commit") return { code: 0, stdout: "[main abc1234] kept\n", stderr: "" };
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc1234\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
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

test("run logging records a kept Run Result, commits workspace, and appends journal", async () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-log-"));
  const execCalls = [];
  try {
    selectActiveResearch(projectDir, "default");
    fs.writeFileSync(researchJournalPath(projectDir), '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}\n');
    const state = createResearchState();
    state.name = "Speed";
    state.metricName = "total_ms";
    state.metricUnit = "ms";

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
      metrics: { compile_ms: 50 },
      asi: { hypothesis: "baseline" },
    }, fakeDeps(projectDir, state, execCalls));

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(result.ok && result.runResult.commit, "abc1234");
    assert.deepEqual(execCalls.map(([command, args]) => `${command} ${args[0]}`), [
      "git add",
      "git diff",
      "git commit",
      "git rev-parse",
    ]);
    const lines = fs.readFileSync(researchJournalPath(projectDir), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /"description":"baseline"/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run logging blocks keep when checks failed before mutating state", async () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-log-"));
  try {
    selectActiveResearch(projectDir, "default");
    const state = createResearchState();
    const deps = fakeDeps(projectDir, state);
    deps.lastRunChecks = { pass: false, output: "nope", duration: 0.1 };

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "bad keep",
    }, deps);

    assert.equal(result.ok, false);
    assert.equal(state.results.length, 0);
    assert.equal(fs.existsSync(researchJournalPath(projectDir)), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
