import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchSummaryFromState } from "../extensions/pi-goal/domain/research-summary.ts";
import { researchStateFromJournal } from "../extensions/pi-goal/persistence/research-state-hydration.ts";

test("research summary exposes current experiment baseline, best, status counts, and recent deltas", () => {
  const state = researchStateFromJournal([
    '{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"a","metric":200,"status":"keep","description":"old base","timestamp":1,"metrics":{}}',
    '{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":2,"commit":"b","metric":100,"status":"keep","description":"base","timestamp":2,"metrics":{}}',
    '{"run":3,"commit":"c","metric":80,"status":"keep","description":"better","timestamp":3,"metrics":{}}',
    '{"run":4,"commit":"d","metric":120,"status":"discard","description":"worse","timestamp":4,"metrics":{},"asi":{"rollback_reason":"slow"}}',
  ].join("\n"));

  const model = buildResearchSummaryFromState(state, { recentRunLimit: 3 });

  assert.equal(model.currentExperiment.runCount, 3);
  assert.deepEqual(model.currentExperiment.statusCounts, {
    keep: 2,
    discard: 1,
    crash: 0,
    checks_failed: 0,
  });
  assert.equal(model.currentExperiment.baseline?.runNumber, 2);
  assert.equal(model.currentExperiment.best?.runNumber, 3);
  assert.equal(model.currentExperiment.best?.deltaPercent, -20);
  assert.deepEqual(model.recentRuns.map((run) => run.runNumber), [2, 3, 4]);
  assert.equal(model.recentRuns[2].deltaPercent, 20);
  assert.equal(model.recentRuns[2].asi?.rollback_reason, "slow");
});
