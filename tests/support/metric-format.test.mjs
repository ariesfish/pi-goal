import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDeltaPercent,
  formatDeltaSuffix,
  formatMetricValue,
  formatPlainMetric,
} from "../../extensions/pi-goal/support/metric-format.ts";

test("metric values are grouped for humans and keep their unit", () => {
  assert.equal(formatMetricValue(15200, "µs"), "15,200µs");
  assert.equal(formatMetricValue(12.5, "ms"), "12.50ms");
  assert.equal(formatMetricValue(0, ""), "0");
  assert.equal(formatMetricValue(-15200, ""), "-15,200");
  assert.equal(formatMetricValue(null, "ms"), "—");
  assert.equal(formatMetricValue(Number.NaN, "ms"), "—");
});

test("prompt-facing metrics stay ungrouped", () => {
  assert.equal(formatPlainMetric(15200), "15200");
  assert.equal(formatPlainMetric(12.5), "12.50");
  assert.equal(formatPlainMetric(80), "80");
  assert.equal(formatPlainMetric(Number.NaN), "—");
});

test("deltas are signed to one decimal and parenthesised on demand", () => {
  assert.equal(formatDeltaPercent(12.5), "+12.5%");
  assert.equal(formatDeltaPercent(-20), "-20.0%");
  assert.equal(formatDeltaPercent(0), "0.0%");
  assert.equal(formatDeltaSuffix(12.5), " (+12.5%)");
  assert.equal(formatDeltaSuffix(-20), " (-20.0%)");
  assert.equal(formatDeltaSuffix(null), "");
});
