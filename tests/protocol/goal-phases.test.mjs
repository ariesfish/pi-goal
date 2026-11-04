import assert from "node:assert/strict";
import test from "node:test";

import {
  beginResearchFraming,
  composeResearchPhaseResumeMessage,
  createResearchPhaseState,
  enterResearchConverging,
  enterResearchProbing,
  researchPhaseSystemPromptFor,
  sealResearchContract,
} from "../../extensions/pi-goal/protocol/research-phase.ts";
import {
  blockingCriteriaHaveChecks,
  computeContractHash,
  legacyMetricContract,
} from "../../extensions/pi-goal/domain/goal-contract.ts";
import {
  hydrateResearchStateFromJournal,
} from "../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";

const options = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

const card = (id, overrides = {}) => ({
  id,
  title: `direction ${id}`,
  mechanism: "a distinct mechanism",
  proxyMetric: "total_ms",
  cost: "half a day",
  risk: "shared state",
  killIf: "tests become order dependent",
  status: "open",
  ...overrides,
});

const evidence = {
  command: "node probe.js",
  value: 9_800,
  outputHash: "sha256:probe",
  at: 1,
};

const validContract = (() => {
  const base = {
    version: 1,
    objective: "cut test time",
    criteria: [
      {
        id: "C1",
        statement: "suite under 10s",
        kind: "metric",
        blocking: true,
        metric: { name: "total_ms", direction: "lower" },
      },
      {
        id: "C2",
        statement: "tests pass",
        kind: "test",
        blocking: true,
        check: { command: "pnpm test", expect: "exit0" },
      },
    ],
    testGlobs: ["**/*.test.*"],
    allowTestEdits: false,
    frozenAt: 10,
  };
  return { ...base, hash: computeContractHash(base) };
})();

test("framing is the default phase when no contract exists", () => {
  const state = createResearchPhaseState();

  beginResearchFraming(state);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "framing");
  assert.match(
    composeResearchPhaseResumeMessage(state, options),
    /RESEARCH_FRAMING_REQUIRED/,
  );
  assert.match(
    composeResearchPhaseResumeMessage(state, options),
    /frame_goal/,
  );
});

test("probing requires at least two complete direction cards", () => {
  const state = createResearchPhaseState();
  beginResearchFraming(state);

  const one = enterResearchProbing(state, [card("D1")]);
  assert.equal(one.ok, false);
  assert.match(one.reason ?? "", /at least two/i);
  assert.equal(state.phase, "framing");

  const incomplete = enterResearchProbing(state, [
    card("D1"),
    card("D2", { killIf: "" }),
  ]);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason ?? "", /kill condition/i);
  assert.equal(state.phase, "framing");

  const two = enterResearchProbing(state, [card("D1"), card("D2")]);
  assert.equal(two.ok, true);
  assert.equal(state.phase, "probing");
  assert.match(
    composeResearchPhaseResumeMessage(state, options),
    /RESEARCH_PROBING_REQUIRED/,
  );
});

test("converging requires every direction closed with evidence", () => {
  const state = createResearchPhaseState();
  beginResearchFraming(state);
  enterResearchProbing(state, [card("D1"), card("D2")]);

  const open = enterResearchConverging(state, [
    card("D1", { status: "kept", evidence }),
    card("D2"),
  ]);
  assert.equal(open.ok, false);
  assert.match(open.reason ?? "", /D2/);
  assert.equal(state.phase, "probing");

  const closed = enterResearchConverging(state, [
    card("D1", { status: "kept", evidence }),
    card("D2", { status: "killed", evidence }),
  ]);
  assert.equal(closed.ok, true);
  assert.equal(state.phase, "converging");
  assert.match(
    composeResearchPhaseResumeMessage(state, options),
    /RESEARCH_CONVERGING_REQUIRED/,
  );
});

test("sealing rejects blocking criteria without an executable check", () => {
  const state = createResearchPhaseState();
  beginResearchFraming(state);
  enterResearchProbing(state, [card("D1"), card("D2")]);
  enterResearchConverging(state, [
    card("D1", { status: "kept", evidence }),
    card("D2", { status: "killed", evidence }),
  ]);

  const manual = {
    ...validContract,
    criteria: [
      { id: "C1", statement: "looks good", kind: "manual", blocking: true },
    ],
  };
  const manualResult = sealResearchContract(state, manual, {});
  assert.equal(manualResult.ok, false);
  assert.match(manualResult.reason ?? "", /manual/i);

  const unchecked = {
    ...validContract,
    criteria: [
      { id: "C1", statement: "tests pass", kind: "test", blocking: true },
    ],
  };
  const uncheckedResult = sealResearchContract(state, unchecked, {});
  assert.equal(uncheckedResult.ok, false);
  assert.match(uncheckedResult.reason ?? "", /executable check/i);

  const ok = sealResearchContract(state, validContract, {});
  assert.equal(ok.ok, true);
  assert.equal(state.phase, "needs_baseline");

  const withBaseline = createResearchPhaseState();
  const sealed = sealResearchContract(withBaseline, validContract, { hasBaseline: true });
  assert.equal(sealed.ok, true);
  assert.equal(withBaseline.phase, "sealed");
});

test("blocking criteria must include at least one criterion and a check or metric", () => {
  assert.equal(blockingCriteriaHaveChecks(validContract), true);

  const guardsOnly = {
    ...validContract,
    criteria: [
      {
        id: "G1",
        statement: "guard",
        kind: "command",
        blocking: false,
        check: { command: "true", expect: "exit0" },
      },
    ],
  };
  assert.equal(blockingCriteriaHaveChecks(guardsOnly), false);
});

test("legacy metric research hydrates a metric contract", () => {
  const state = createResearchState();
  const journal = [
    '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"abc1234","metric":100,"status":"keep","description":"baseline","timestamp":1,"metrics":{}}',
  ].join("\n");

  hydrateResearchStateFromJournal(state, journal);

  assert.ok(state.contract);
  assert.equal(state.contract?.criteria.length, 1);
  assert.equal(state.contract?.criteria[0].kind, "metric");
  assert.equal(state.contract?.criteria[0].metric?.name, "total_ms");
  assert.match(state.contract?.hash ?? "", /^sha256:/);
});

test("legacy contract is stable for the same metric and direction", () => {
  const first = legacyMetricContract({ metricName: "total_ms", direction: "lower" });
  const second = legacyMetricContract({ metricName: "total_ms", direction: "lower" });

  assert.equal(first.hash, second.hash);
  assert.notEqual(
    first.hash,
    legacyMetricContract({ metricName: "total_ms", direction: "higher" }).hash,
  );
});

test("system prompt names the framing action and the contract tools", () => {
  const state = createResearchPhaseState();
  beginResearchFraming(state);

  const prompt = researchPhaseSystemPromptFor(state, {
    hasRules: true,
    hasConfig: false,
    hasBenchmarkScript: true,
    hasIdeas: false,
    hasChecks: false,
    mdPath: "/repo/goal.md",
    ideasPath: "/repo/goal.ideas.md",
    checksPath: "/repo/goal.checks.sh",
  }, options);

  assert.match(prompt, /Phase: framing/);
  assert.match(prompt, /frame_goal/);
});
