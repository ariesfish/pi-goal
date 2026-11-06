import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { recordRunResult } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import {
  createFakePiExec,
  journalPath,
  tempProject,
} from "../helpers/research-fixture.mjs";

const contract = {
  version: 1,
  objective: "cut test time",
  criteria: [
    {
      id: "C1",
      statement: "suite faster",
      kind: "metric",
      blocking: true,
      metric: { name: "total_ms", direction: "lower" },
    },
  ],
  testGlobs: ["**/*.test.*"],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

function reviewerScript(workDir, repro) {
  const script = path.join(workDir, "reviewer.mjs");
  const findings = [
    {
      id: "F1",
      severity: "blocking",
      claim: "edge case missing",
      repro: { kind: "command", payload: repro },
    },
  ];
  fs.writeFileSync(
    script,
    [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify({ findings }))});`,
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(workDir, "goal.config.json"),
    JSON.stringify({
      reviewer: {
        command: process.execPath,
        args: [script],
        blocking: true,
        timeoutSeconds: 10,
      },
    }),
  );
  return script;
}

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
        baseline_metric: currentState.baselineMetric,
        best_metric: currentState.baselineMetric,
        run_count: currentState.results.length,
        goal: currentState.name ?? "",
      };
    },
  };
}

function newState() {
  const state = createResearchState();
  state.name = "Speed";
  state.metricName = "total_ms";
  state.metricUnit = "ms";
  state.bestDirection = "lower";
  state.contract = contract;
  return state;
}

test("a reproduced blocking finding from the reviewer denies a keep", async () => {
  const projectDir = tempProject("pi-goal-review-gate");
  try {
    selectActiveResearch(projectDir, "default");
    reviewerScript(projectDir, "exit 1");
    const state = newState();
    const deps = fakeDeps(projectDir, state, {
      "bash -c": () => ({ code: 1, stdout: "", stderr: "" }),
    });

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "should not land",
    }, deps);

    assert.equal(result.ok, false);
    assert.match(result.text, /Keep denied/);
    assert.equal(state.results.length, 0);
    assert.equal(state.reviews.length, 1);
    assert.equal(state.reviews[0].findings[0].reproduced, true);
    assert.equal(deps._calls.some(([command, args]) => command === "git" && args[0] === "commit"), false);

    const entries = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.some((entry) => entry.type === "gate"), true);
    assert.equal(entries.some((entry) => entry.type === "review"), true);
    assert.equal(entries.some((entry) => entry.run === 1), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("an unreproduced finding records a review but allows the keep", async () => {
  const projectDir = tempProject("pi-goal-review-gate");
  try {
    selectActiveResearch(projectDir, "default");
    reviewerScript(projectDir, "exit 0");
    const state = newState();
    const deps = fakeDeps(projectDir, state, {
      "bash -c": () => ({ code: 0, stdout: "", stderr: "" }),
    });

    const result = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(state.results.length, 1);
    assert.equal(state.reviews.length, 1);
    assert.match(result.text, /not reproduced/);

    const entries = fs.readFileSync(journalPath(projectDir), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const review = entries.find((entry) => entry.type === "review");
    assert.equal(review.review.findings[0].reproduced, false);
    assert.equal(entries.some((entry) => entry.run === 1), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
