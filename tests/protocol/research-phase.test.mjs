import assert from "node:assert/strict";
import test from "node:test";

import {
  activateResearch,
  composeResearchPhaseResumeMessage,
  createResearchPhaseState,
  detectPreContractPhase,
  enterResearchNeedsInitFromFiles,
  researchAwaitingLogBlockMessage,
  onResearchInitialized,
  onResearchRunLogged,
  onResearchRunFinished,
  shouldResearchAutoResumeAfterTurn,
  shouldBlockResearchRun,
  researchPhaseSystemPromptFor,
} from "../../extensions/pi-goal/protocol/research-phase.ts";

const options = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

function assertProtocol(text, { marker, tool }) {
  assert.match(text, new RegExp(marker));
  if (tool) assert.match(text, new RegExp(tool));
}

test("activation without a contract enters framing and emits mandatory protocol", () => {
  const state = createResearchPhaseState();
  const message = activateResearch(state, {
    userGoal: "optimize tests",
    hasRules: false,
    hasConfig: false,
    hasBenchmarkScript: false,
  }, options);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "framing");
  assertProtocol(message, { marker: "RESEARCH_FRAMING_REQUIRED", tool: "frame_goal" });
  assert.equal(shouldResearchAutoResumeAfterTurn(state, options), true);
});

test("existing goal files without a contract start framing, while file sync detects needs_init", () => {
  const state = createResearchPhaseState();
  const message = activateResearch(state, {
    userGoal: "resume",
    hasRules: true,
    hasConfig: false,
    hasBenchmarkScript: true,
  }, options);

  assert.equal(state.phase, "framing");
  assertProtocol(message, { marker: "RESEARCH_FRAMING_REQUIRED", tool: "frame_goal" });
  assert.equal(detectPreContractPhase({ hasRules: true, hasBenchmarkScript: true }), "needs_init");

  const setup = createResearchPhaseState();
  enterResearchNeedsInitFromFiles(setup);
  assertProtocol(composeResearchPhaseResumeMessage(setup, options), { marker: "RESEARCH_INIT_REQUIRED", tool: "init_goal" });
});

test("init_goal transitions to mandatory baseline phase", () => {
  const state = createResearchPhaseState();

  onResearchInitialized(state);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "needs_baseline");
  assert.equal(shouldResearchAutoResumeAfterTurn(state, options), true);
  assertProtocol(composeResearchPhaseResumeMessage(state, options), { marker: "RESEARCH_BASELINE_REQUIRED", tool: "run_goal" });
});

test("run_goal transitions to awaiting_log and blocks another run", () => {
  const state = createResearchPhaseState();

  onResearchRunFinished(state, {
    command: "bash goal.sh",
    passed: true,
    crashed: false,
    timedOut: false,
    checksPass: false,
    checksTimedOut: false,
    parsedPrimary: 123,
    parsedMetrics: { total_ms: 123, compile_ms: 4 },
    metricName: "total_ms",
    metricUnit: "ms",
  });

  assert.equal(state.phase, "awaiting_log");
  assert.equal(shouldResearchAutoResumeAfterTurn(state, options), true);
  assert.equal(shouldBlockResearchRun(state), true);
  assert.match(researchAwaitingLogBlockMessage(state), /Previous run_goal has not been logged/);
  assert.match(researchAwaitingLogBlockMessage(state), /status: "checks_failed"/);
  assert.match(researchAwaitingLogBlockMessage(state), /metric: 123/);
});

test("log_goal transitions from awaiting_log to looping or limit reached", () => {
  const state = createResearchPhaseState();
  onResearchRunFinished(state, {
    command: "bash goal.sh",
    passed: true,
    crashed: false,
    timedOut: false,
    checksPass: true,
    checksTimedOut: false,
    parsedPrimary: 90,
    parsedMetrics: { total_ms: 90 },
    metricName: "total_ms",
    metricUnit: "ms",
  });

  onResearchRunLogged(state, false);
  assert.equal(state.phase, "sealed");
  assert.equal(state.mode, true);
  assert.equal(state.lastRun, null);
  assert.equal(shouldResearchAutoResumeAfterTurn(state, options), true);

  onResearchRunLogged(state, true);
  assert.equal(state.phase, "limit_reached");
  assert.equal(state.mode, false);
});

test("system prompt injects phase-specific required action", () => {
  const state = createResearchPhaseState();
  onResearchInitialized(state);

  const prompt = researchPhaseSystemPromptFor(state, {
    hasRules: true,
    hasConfig: true,
    hasBenchmarkScript: true,
    hasIdeas: true,
    hasChecks: true,
    mdPath: "/repo/goal.md",
    ideasPath: "/repo/goal.ideas.md",
    checksPath: "/repo/goal.checks.sh",
  }, options);

  assert.match(prompt, /Phase: needs_baseline/);
  assert.match(prompt, /run_goal/);
  assert.match(prompt, /Backpressure Checks/);
  assert.match(prompt, /Ideas backlog/);
});

const DIRECTION = {
  id: "D1",
  title: "cache hot paths",
  mechanism: "memoize",
  proxyMetric: "hits",
  cost: "1h",
  risk: "stale reads",
  killIf: "hit rate < 10%",
  status: "open",
};

const CLOSED = {
  ...DIRECTION,
  status: "kept",
  evidence: { command: "probe", value: 42, outputHash: "sha256:abc", at: 1 },
};

const SEALABLE_CONTRACT = {
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
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

test("a setup epoch resets the activation budget; phases inside one keep counting", async () => {
  const {
    enterResearchProbing,
    enterResearchConverging,
    sealResearchContract,
    markResearchAutoResumeSent,
  } = await import("../../extensions/pi-goal/protocol/research-phase.ts");

  const state = createResearchPhaseState();
  activateResearch(state, {
    userGoal: "optimize tests",
    hasRules: false,
    hasConfig: false,
    hasBenchmarkScript: false,
  }, options);

  markResearchAutoResumeSent(state);
  markResearchAutoResumeSent(state);
  assert.equal(state.activationTurns, 2);

  assert.equal(enterResearchProbing(state, [DIRECTION, { ...DIRECTION, id: "D2" }]).ok, true);
  assert.equal(state.activationTurns, 2);

  assert.equal(enterResearchConverging(state, [CLOSED, { ...CLOSED, id: "D2" }]).ok, true);
  assert.equal(state.activationTurns, 2);

  // Sealing starts a new setup epoch.
  assert.equal(sealResearchContract(state, SEALABLE_CONTRACT, { hasBaseline: true }).ok, true);
  assert.equal(state.activationTurns, 0);
});
