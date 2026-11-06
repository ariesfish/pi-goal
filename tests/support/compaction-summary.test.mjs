import assert from "node:assert/strict";
import test from "node:test";

import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import { renderCompactionSummary } from "../../extensions/pi-goal/support/compaction-summary.ts";

const CONTRACT = {
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

function stateWithRuns() {
  const state = createResearchState();
  state.name = "Speed";
  state.metricName = "total_ms";
  state.metricUnit = "ms";
  state.bestDirection = "lower";
  state.contract = CONTRACT;
  state.results = [
    {
      commit: "aaa1111",
      metric: 100,
      metrics: {},
      status: "keep",
      description: "baseline",
      timestamp: 1,
      experimentIndex: 0,
      confidence: null,
    },
    {
      commit: "bbb2222",
      metric: 120,
      metrics: {},
      status: "discard",
      description: "slower",
      timestamp: 2,
      experimentIndex: 0,
      confidence: null,
    },
  ];
  return state;
}

test("the summary renders from data alone, with no filesystem", () => {
  const text = renderCompactionSummary({
    state: stateWithRuns(),
    phase: "sealed",
    rulesText: "# Rules\n\n- do not cheat",
    ideasText: "- try pooling",
  });

  assert.match(text, /## Phase\n\nsealed/);
  assert.match(text, /## Goal Contract/);
  assert.match(text, /Hash: sha256:test/);
  assert.match(text, /Test protection: \*\*\/\*\.test\.\*/);
  assert.match(text, /## Research\n\nGoal: Speed/);
  assert.match(text, /Baseline \(#1\): 100ms/);
  assert.match(text, /## Research Rules \(goal\.md\)\n\n# Rules/);
  assert.match(text, /## Ideas Backlog \(goal\.ideas\.md\)\n\n- try pooling/);
  assert.match(text, /#1 keep\s+100/);
  assert.match(text, /#2 discard\s+120 \(\+20\.0%\)/);
  assert.match(text, /## Next Step/);
});

test("empty narrative files and a missing contract leave their sections out", () => {
  const text = renderCompactionSummary({
    state: createResearchState(),
    phase: "framing",
    rulesText: "",
    ideasText: "",
  });

  assert.match(text, /## Goal Contract\n\nNot frozen yet/);
  assert.doesNotMatch(text, /## Research Rules/);
  assert.doesNotMatch(text, /## Ideas Backlog/);
  assert.match(text, /## Recent Runs\n\nNo runs yet/);
  assert.match(text, /Call frame_goal with at least two orthogonal direction cards/);
});
