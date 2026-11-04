import assert from "node:assert/strict";
import test from "node:test";

import {
  blockingCriteriaProgress,
  computeContractHash,
  legacyMetricContract,
} from "../../extensions/pi-goal/domain/goal-contract.ts";

const contract = {
  version: 1,
  objective: "cut test time",
  criteria: [
    { id: "C1", statement: "faster", kind: "metric", blocking: true, metric: { name: "total_ms", direction: "lower" } },
    { id: "C2", statement: "passes", kind: "test", blocking: true, check: { command: "true", expect: "exit0" } },
    { id: "C3", statement: "manual", kind: "manual", blocking: false },
  ],
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

test("blocking progress ignores non-contract gate verdicts", () => {
  const gate = {
    verdict: "pass",
    contractHash: "sha256:test",
    checkedAt: 1,
    criteria: [
      { criterionId: "C1", pass: true, blocking: true, detail: "" },
      { criterionId: "C2", pass: false, blocking: true, detail: "" },
      { criterionId: "L2-tests", pass: true, blocking: true, detail: "" },
      { criterionId: "L2-scope", pass: true, blocking: true, detail: "" },
    ],
  };

  assert.deepEqual(blockingCriteriaProgress(contract, gate), { passed: 1, total: 2 });
  assert.deepEqual(blockingCriteriaProgress(contract, null), { passed: 0, total: 2 });
  assert.deepEqual(blockingCriteriaProgress(null, gate), { passed: 0, total: 0 });
});

test("legacy contracts hash stably", () => {
  const first = legacyMetricContract({ metricName: "total_ms", direction: "lower" });
  const second = legacyMetricContract({ metricName: "total_ms", direction: "lower" });
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash, computeContractHash(first));
});
