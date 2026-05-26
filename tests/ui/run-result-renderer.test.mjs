import assert from "node:assert/strict";
import test from "node:test";

import { buildRunExperimentResponseText } from "../../extensions/pi-goal/ui/run-result-renderer.ts";

function details(overrides = {}) {
  return {
    command: "bash goal.sh",
    exitCode: 0,
    durationSeconds: 1.23,
    passed: true,
    crashed: false,
    timedOut: false,
    tailOutput: "",
    checksPass: null,
    checksTimedOut: false,
    checksOutput: "",
    checksDuration: 0,
    parsedMetrics: null,
    parsedPrimary: null,
    metricName: "total_ms",
    metricUnit: "ms",
    ...overrides,
  };
}

test("run result response reports parsed metrics and machine-ready log values", () => {
  const text = buildRunExperimentResponseText({
    details: details({
      parsedMetrics: { total_ms: 12, compile_ms: 3 },
      parsedPrimary: 12,
    }),
    llmOutput: "METRIC total_ms=12",
    requirePrimaryMetric: true,
  });

  assert.match(text, /✅ PASSED in 1\.2s/);
  assert.match(text, /📐 Parsed metrics: ★ total_ms=12ms compile_ms=3ms/);
  assert.match(text, /Use these values directly in log_goal \(metric: 12, metrics: \{"compile_ms": 3\}\)/);
});

test("run result response flags missing primary metric when goal.sh is required", () => {
  const text = buildRunExperimentResponseText({
    details: details({ parsedMetrics: { other_ms: 4 }, parsedPrimary: null }),
    llmOutput: "METRIC other_ms=4",
    requirePrimaryMetric: true,
  });

  assert.match(text, /❌ PRIMARY METRIC MISSING/);
  assert.match(text, /Expected output line: METRIC total_ms=<number>/);
  assert.match(text, /Log this as 'crash'/);
});

test("run result response reports checks failure and includes checks output", () => {
  const text = buildRunExperimentResponseText({
    details: details({
      passed: false,
      crashed: true,
      checksPass: false,
      checksOutput: "assertion failed",
      checksDuration: 2,
    }),
    llmOutput: "bench ok",
    requirePrimaryMetric: false,
  });

  assert.match(text, /💥 CHECKS FAILED \(goal\.checks\.sh\) in 2\.0s/);
  assert.match(text, /Log this as 'checks_failed'/);
  assert.match(text, /── Checks output \(last 80 lines\) ──\nassertion failed/);
});
