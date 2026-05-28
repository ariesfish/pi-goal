import assert from "node:assert/strict";
import test from "node:test";

import { inferMetricUnit } from "../../extensions/pi-goal/domain/metric-definition.ts";
import {
  cloneResearchState,
  computeConfidence,
  createResearchState,
  currentRuns,
  findBaselineMetric,
  findBaselineRunNumber,
  findBaselineSecondary,
  findBestMetric,
  registerSecondaryMetrics,
} from "../../extensions/pi-goal/domain/research-state.ts";

function run(overrides) {
  return {
    commit: "abcdef0",
    metric: 100,
    metrics: {},
    status: "keep",
    description: "run",
    timestamp: 1,
    experimentIndex: 0,
    confidence: null,
    ...overrides,
  };
}

test("research state queries stay scoped to the current experiment", () => {
  const results = [
    run({ metric: 200, experimentIndex: 0 }),
    run({ metric: 150, experimentIndex: 0 }),
    run({ metric: 100, experimentIndex: 1 }),
    run({ metric: 80, experimentIndex: 1, status: "discard" }),
    run({ metric: 90, experimentIndex: 1 }),
  ];

  assert.deepEqual(currentRuns(results, 1).map((result) => result.metric), [100, 80, 90]);
  assert.equal(findBaselineMetric(results, 1), 100);
  assert.equal(findBaselineRunNumber(results, 1), 3);
  assert.equal(findBestMetric(results, 1, "lower"), 90);
  assert.equal(findBestMetric(results, 1, "higher"), 100);
});

test("metric unit inference recognizes known suffixes", () => {
  assert.equal(inferMetricUnit("compile_µs"), "µs");
  assert.equal(inferMetricUnit("compile_ms"), "ms");
  assert.equal(inferMetricUnit("duration_s"), "s");
  assert.equal(inferMetricUnit("duration_sec"), "s");
  assert.equal(inferMetricUnit("bundle_kb"), "kb");
  assert.equal(inferMetricUnit("bundle_mb"), "mb");
  assert.equal(inferMetricUnit("tokens"), "");
});

test("secondary metric registration infers units and avoids duplicates", () => {
  const state = createResearchState();

  registerSecondaryMetrics(state, {
    compile_ms: 10,
    render_kb: 20,
  });
  registerSecondaryMetrics(state, {
    compile_ms: 12,
    tokens: 30,
  });

  assert.deepEqual(state.secondaryMetrics, [
    { name: "compile_ms", unit: "ms" },
    { name: "render_kb", unit: "kb" },
    { name: "tokens", unit: "" },
  ]);
});

test("secondary baselines fall back to first occurrence in the experiment", () => {
  const knownMetrics = [{ name: "compile_ms", unit: "ms" }, { name: "render_ms", unit: "ms" }];
  const results = [
    run({ experimentIndex: 1, metrics: { compile_ms: 10 } }),
    run({ experimentIndex: 1, metrics: { compile_ms: 8, render_ms: 5 } }),
    run({ experimentIndex: 1, metrics: { compile_ms: 7, render_ms: 4 } }),
  ];

  assert.deepEqual(findBaselineSecondary(results, 1, knownMetrics), {
    compile_ms: 10,
    render_ms: 5,
  });
});

test("confidence compares best kept improvement against MAD noise", () => {
  const results = [
    run({ metric: 100 }),
    run({ metric: 90 }),
    run({ metric: 110, status: "discard" }),
  ];

  assert.equal(computeConfidence(results, 0, "lower"), 1);
});

test("cloneResearchState deep-clones mutable result collections", () => {
  const state = createResearchState();
  state.results.push(run({ metrics: { compile_ms: 10 }, asi: { hypothesis: "h" } }));
  state.secondaryMetrics.push({ name: "compile_ms", unit: "ms" });

  const cloned = cloneResearchState(state);
  cloned.results[0].metrics.compile_ms = 99;
  cloned.results[0].asi.hypothesis = "changed";
  cloned.secondaryMetrics[0].unit = "s";

  assert.equal(state.results[0].metrics.compile_ms, 10);
  assert.equal(state.results[0].asi.hypothesis, "h");
  assert.equal(state.secondaryMetrics[0].unit, "ms");
});
