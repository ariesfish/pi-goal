import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGateFailure,
  runGate,
} from "../../extensions/pi-goal/execution/gate-runner.ts";
import { matchGlob } from "../../extensions/pi-goal/support/glob.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";

const baseContract = (overrides = {}) => ({
  version: 1,
  objective: "cut test time",
  criteria: [],
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
  ...overrides,
});

const metricCriterion = (overrides = {}) => ({
  id: "C1",
  statement: "suite faster",
  kind: "metric",
  blocking: true,
  metric: { name: "total_ms", direction: "lower", ...overrides },
});

const commandCriterion = (check = { command: "true", expect: "exit0" }, overrides = {}) => ({
  id: "C2",
  statement: "check passes",
  kind: "command",
  blocking: true,
  check,
  ...overrides,
});

function stateWith(results = []) {
  const state = createResearchState();
  state.metricName = "total_ms";
  state.results = results;
  return state;
}

function runRecord(metric, experimentIndex = 0) {
  return {
    commit: "abc1234",
    metric,
    metrics: {},
    status: "keep",
    description: "run",
    timestamp: 1,
    experimentIndex,
    confidence: null,
  };
}

function fakePi(overrides = {}) {
  return {
    async exec(command, args) {
      const key = `${command} ${args[0] ?? ""}`.trim();
      if (overrides[key]) return overrides[key](command, args);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

test("glob matching handles **, *, and root files", () => {
  assert.equal(matchGlob("tests/foo.test.js", "**/*.test.*"), true);
  assert.equal(matchGlob("foo.test.js", "**/*.test.*"), true);
  assert.equal(matchGlob("src/foo.ts", "src/**"), true);
  assert.equal(matchGlob("src/deep/foo.ts", "src/**"), true);
  assert.equal(matchGlob("docs/foo.md", "src/**"), false);
  assert.equal(matchGlob("src/foo.ts", "src/*.ts"), true);
  assert.equal(matchGlob("src/deep/foo.ts", "src/*.ts"), false);
});

test("a passing command criterion and baseline metric pass the gate", async () => {
  const gate = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion(), commandCriterion()] }),
    state: stateWith(),
    metric: 100,
    changedPaths: [],
  });

  assert.equal(gate.verdict, "pass");
  assert.equal(gate.criteria.every((verdict) => verdict.pass), true);
});

test("a failing check blocks the gate and names the criterion", async () => {
  const gate = await runGate({
    pi: fakePi({ "bash -c": () => ({ code: 1, stdout: "boom", stderr: "" }) }),
    workDir: "/tmp",
    contract: baseContract({ criteria: [commandCriterion()] }),
    state: stateWith(),
    metric: 100,
    changedPaths: [],
  });

  assert.equal(gate.verdict, "fail");
  const failed = gate.criteria.find((verdict) => verdict.criterionId === "C2");
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /exit 1/);
  assert.match(formatGateFailure(gate), /C2/);
});

test("stdout expectations use contains and regex", async () => {
  const contains = await runGate({
    pi: fakePi({ "bash -c": () => ({ code: 0, stdout: "all 42 tests pass", stderr: "" }) }),
    workDir: "/tmp",
    contract: baseContract({
      criteria: [commandCriterion({ command: "run", expect: "stdout_contains", pattern: "42 tests pass" })],
    }),
    state: stateWith(),
    metric: 1,
    changedPaths: [],
  });
  assert.equal(contains.verdict, "pass");

  const regex = await runGate({
    pi: fakePi({ "bash -c": () => ({ code: 0, stdout: "coverage 91.5%", stderr: "" }) }),
    workDir: "/tmp",
    contract: baseContract({
      criteria: [commandCriterion({ command: "run", expect: "stdout_regex", pattern: "coverage \\d+\\.\\d+%" })],
    }),
    state: stateWith(),
    metric: 1,
    changedPaths: [],
  });
  assert.equal(regex.verdict, "pass");
});

test("a metric regression fails and a better metric passes", async () => {
  const regressed = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion()] }),
    state: stateWith([runRecord(100)]),
    metric: 120,
    changedPaths: [],
  });
  assert.equal(regressed.verdict, "fail");
  assert.match(regressed.criteria[0].detail, /did not improve/);

  const improved = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion()] }),
    state: stateWith([runRecord(100)]),
    metric: 90,
    changedPaths: [],
  });
  assert.equal(improved.verdict, "pass");
});

test("min_delta_pct rejects an improvement that is too small", async () => {
  const small = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion({ minDeltaPct: 20 })] }),
    state: stateWith([runRecord(100)]),
    metric: 95,
    changedPaths: [],
  });
  assert.equal(small.verdict, "fail");
  assert.match(small.criteria[0].detail, /below the required 20%/);

  const enough = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion({ minDeltaPct: 20 })] }),
    state: stateWith([runRecord(100)]),
    metric: 80,
    changedPaths: [],
  });
  assert.equal(enough.verdict, "pass");
});

test("noise-level improvement needs force_keep", async () => {
  const state = stateWith([runRecord(100)]);
  state.confidence = 0.5;
  const contract = baseContract({ criteria: [metricCriterion()] });

  const blocked = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state,
    metric: 98,
    changedPaths: [],
  });
  assert.equal(blocked.verdict, "fail");
  assert.match(blocked.criteria[0].detail, /within noise/);

  const forced = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state,
    metric: 98,
    changedPaths: [],
    forceKeep: true,
  });
  assert.equal(forced.verdict, "pass");
});

test("protected test files fail the gate unless edits are allowed", async () => {
  const contract = baseContract({
    criteria: [metricCriterion()],
    testGlobs: ["**/*.test.*"],
  });

  const blocked = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith(),
    metric: 100,
    changedPaths: ["tests/foo.test.js"],
  });
  assert.equal(blocked.verdict, "fail");
  assert.equal(blocked.criteria.find((verdict) => verdict.criterionId === "L2-tests").pass, false);

  const allowed = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: { ...contract, allowTestEdits: true },
    state: stateWith(),
    metric: 100,
    changedPaths: ["tests/foo.test.js"],
  });
  assert.equal(allowed.verdict, "pass");
});

test("changed paths outside scope_globs fail the gate", async () => {
  const contract = baseContract({
    criteria: [metricCriterion()],
    scopeGlobs: ["src/**"],
  });

  const inside = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith(),
    metric: 100,
    changedPaths: ["src/a.ts"],
  });
  assert.equal(inside.verdict, "pass");

  const outside = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith(),
    metric: 100,
    changedPaths: ["docs/readme.md"],
  });
  assert.equal(outside.verdict, "fail");
  assert.match(outside.criteria.find((verdict) => verdict.criterionId === "L2-scope").detail, /docs\/readme.md/);
});

test("the session test-edit policy unlocks protected files", async () => {
  const state = stateWith();
  state.testEditsAllowed = true;
  const gate = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract: baseContract({ criteria: [metricCriterion()], testGlobs: ["**/*.test.*"] }),
    state,
    metric: 100,
    changedPaths: ["tests/foo.test.js"],
  });
  assert.equal(gate.verdict, "pass");
});

test("guard metric criteria compare their own metric, not the primary", async () => {
  const contract = baseContract({
    criteria: [
      metricCriterion(),
      {
        id: "C3",
        statement: "bundle does not grow",
        kind: "metric",
        blocking: true,
        metric: { name: "bundle_kb", direction: "lower" },
      },
    ],
  });
  const baseline = { ...runRecord(100), metrics: { bundle_kb: 50 } };

  const guardOk = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith([baseline]),
    metric: 90,
    metrics: { bundle_kb: 45 },
    changedPaths: [],
  });
  assert.equal(guardOk.verdict, "pass");

  const guardBad = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith([baseline]),
    metric: 90,
    metrics: { bundle_kb: 70 },
    changedPaths: [],
  });
  assert.equal(guardBad.verdict, "fail");
  assert.match(guardBad.criteria.find((v) => v.criterionId === "C3").detail, /did not improve/);

  const missing = await runGate({
    pi: fakePi(),
    workDir: "/tmp",
    contract,
    state: stateWith([baseline]),
    metric: 90,
    changedPaths: [],
  });
  assert.equal(missing.verdict, "fail");
  assert.match(missing.criteria.find((v) => v.criterionId === "C3").detail, /missing metric value/);
});
