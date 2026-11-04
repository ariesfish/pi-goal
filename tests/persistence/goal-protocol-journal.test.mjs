import assert from "node:assert/strict";
import test from "node:test";

import {
  parseResearchJournalModel,
} from "../../extensions/pi-goal/persistence/research-journal-codec.ts";
import {
  researchStateFromJournal,
} from "../../extensions/pi-goal/persistence/research-state-hydration.ts";

const CONTRACT = {
  version: 1,
  objective: "Cut unit test runtime without weakening coverage",
  criteria: [
    {
      id: "C1",
      statement: "suite median under 10s",
      kind: "metric",
      blocking: true,
      metric: { name: "total_ms", direction: "lower" },
    },
    {
      id: "C2",
      statement: "test suite passes",
      kind: "test",
      blocking: true,
      check: { command: "pnpm test", expect: "exit0" },
    },
    {
      id: "C3",
      statement: "no new flaky failures",
      kind: "manual",
      blocking: false,
    },
  ],
  testGlobs: ["**/*.test.*"],
  allowTestEdits: false,
  frozenAt: 1_700_000_000_000,
  hash: "sha256:contract-1",
};

const DIRECTION = {
  id: "D1",
  title: "Parallelize the slow fixtures",
  mechanism: "share setup across test files",
  proxyMetric: "total_ms",
  cost: "1 day",
  risk: "shared state leaks",
  killIf: "any test becomes order dependent",
  status: "kept",
  evidence: {
    command: "pnpm test",
    value: 9_800,
    outputHash: "sha256:probe-1",
    at: 1_700_000_000_100,
  },
};

function journal(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

const LEGACY_CONFIG = {
  type: "config",
  name: "Speed",
  metricName: "total_ms",
  metricUnit: "ms",
  bestDirection: "lower",
};

const LEGACY_RUN = {
  run: 1,
  commit: "abc1234",
  metric: 12_000,
  metrics: {},
  status: "keep",
  description: "baseline",
  timestamp: 1,
  experimentIndex: 0,
  confidence: null,
};

test("replays contract, directions, probes, gates, reviews, and attempts", () => {
  const state = researchStateFromJournal(journal([
    LEGACY_CONFIG,
    LEGACY_RUN,
    { type: "contract", contract: CONTRACT },
    { type: "direction", direction: DIRECTION },
    {
      type: "probe",
      probe: {
        directionId: "D1",
        command: "pnpm test",
        value: 9_800,
        evidenceHash: "sha256:probe-1",
        decision: "keep",
        at: 1_700_000_000_100,
      },
    },
    {
      type: "gate",
      gate: {
        verdict: "pass",
        contractHash: "sha256:contract-1",
        checkedAt: 1_700_000_000_200,
        criteria: [
          { criterionId: "C1", pass: true, blocking: true, detail: "9.8s" },
          { criterionId: "C2", pass: true, blocking: true, detail: "exit 0" },
        ],
      },
    },
    {
      type: "review",
      review: {
        reviewer: "codex",
        at: 1_700_000_000_300,
        findings: [
          {
            id: "F1",
            severity: "advisory",
            claim: "fixture helper duplicates setup",
            reproduced: false,
          },
        ],
      },
    },
    {
      type: "attempt",
      attempt: {
        run: 2,
        status: "discard",
        checkpoint: "abc1234",
        patchPath: ".goal/researches/default/attempts/2.patch",
        description: "tried worker threads",
        at: 1_700_000_000_400,
      },
    },
  ]));

  assert.equal(state.contract?.hash, "sha256:contract-1");
  assert.deepEqual(state.contract?.criteria.map((criterion) => criterion.id), ["C1", "C2", "C3"]);
  assert.equal(state.contract?.criteria[0].metric?.name, "total_ms");

  assert.equal(state.directions.length, 1);
  assert.equal(state.directions[0].status, "kept");
  assert.equal(state.directions[0].evidence?.value, 9_800);

  assert.equal(state.probes.length, 1);
  assert.equal(state.probes[0].decision, "keep");

  assert.equal(state.gates.length, 1);
  assert.equal(state.gates[0].verdict, "pass");
  assert.equal(state.gates[0].criteria[1].pass, true);

  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].findings[0].reproduced, false);

  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].checkpoint, "abc1234");

  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].metric, 12_000);
});

test("legacy journals replay with empty protocol state", () => {
  const state = researchStateFromJournal(journal([LEGACY_CONFIG, LEGACY_RUN]));

  assert.equal(state.contract, null);
  assert.deepEqual(state.directions, []);
  assert.deepEqual(state.probes, []);
  assert.deepEqual(state.gates, []);
  assert.deepEqual(state.reviews, []);
  assert.deepEqual(state.attempts, []);
  assert.equal(state.results.length, 1);
});

test("malformed protocol entries are skipped without losing run data", () => {
  const state = researchStateFromJournal(journal([
    LEGACY_CONFIG,
    { type: "contract", contract: { objective: "missing hash" } },
    { type: "direction", direction: { title: "missing id" } },
    { type: "probe", probe: { directionId: "D1" } },
    { type: "gate", gate: { verdict: "maybe" } },
    { type: "review", review: { findings: "not-an-array" } },
    { type: "attempt", attempt: { status: "discard" } },
    { type: "future-entry", payload: true },
    LEGACY_RUN,
  ]));

  assert.equal(state.contract, null);
  assert.equal(state.directions.length, 0);
  assert.equal(state.probes.length, 0);
  assert.equal(state.gates.length, 0);
  assert.equal(state.reviews.length, 0);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.results.length, 1);
});

test("the latest direction snapshot wins", () => {
  const killed = {
    ...DIRECTION,
    status: "killed",
    evidence: { ...DIRECTION.evidence, value: 11_500 },
  };
  const state = researchStateFromJournal(journal([
    LEGACY_CONFIG,
    { type: "direction", direction: DIRECTION },
    { type: "direction", direction: killed },
  ]));

  assert.equal(state.directions.length, 1);
  assert.equal(state.directions[0].status, "killed");
  assert.equal(state.directions[0].evidence?.value, 11_500);
});

test("journal model exposes the protocol state alongside runs", () => {
  const model = parseResearchJournalModel(journal([
    LEGACY_CONFIG,
    { type: "contract", contract: CONTRACT },
    LEGACY_RUN,
  ]));

  assert.equal(model.contract?.hash, "sha256:contract-1");
  assert.equal(model.results.length, 1);
});
