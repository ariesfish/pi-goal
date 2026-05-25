import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboardLines } from "../extensions/pi-goal/ui/dashboard-renderer.ts";
import { createResearchState } from "../extensions/pi-goal/domain/research-state.ts";

const plainTheme = {
  fg(_color, text) { return text; },
  bold(text) { return text; },
};

test("dashboard full mode renders runs older than the default summary recent limit", () => {
  const state = createResearchState();
  state.name = "Long research";
  state.metricName = "total_ms";
  state.metricUnit = "ms";
  state.bestDirection = "lower";
  state.bestMetric = 100;

  for (let i = 1; i <= 75; i++) {
    state.results.push({
      commit: `c${i}`,
      metric: 100 + i,
      metrics: {},
      status: "keep",
      description: `run-${i}`,
      timestamp: i,
      experimentIndex: 0,
      confidence: null,
    });
  }

  const lines = renderDashboardLines(state, 120, plainTheme, 0).join("\n");

  assert.match(lines, /run-1/);
  assert.match(lines, /run-75/);
});
