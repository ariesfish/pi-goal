import assert from "node:assert/strict";
import test from "node:test";

import {
  activateResearch,
  composeResearchPhaseResumeMessage,
  createResearchPhaseState,
  detectPhaseFromFiles,
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

test("activation without config enters setup phase and emits mandatory protocol", () => {
  const state = createResearchPhaseState();
  const message = activateResearch(state, {
    userGoal: "optimize tests",
    hasRules: false,
    hasConfig: false,
    hasBenchmarkScript: false,
  }, options);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "activating");
  assertProtocol(message, { marker: "RESEARCH_ACTIVATION_REQUIRED", tool: "init_goal" });
  assert.equal(shouldResearchAutoResumeAfterTurn(state, options), true);
});

test("existing goal files without config enter needs_init", () => {
  const state = createResearchPhaseState();
  const message = activateResearch(state, {
    userGoal: "resume",
    hasRules: true,
    hasConfig: false,
    hasBenchmarkScript: true,
  }, options);

  assert.equal(state.phase, "needs_init");
  assertProtocol(message, { marker: "RESEARCH_ACTIVATION_REQUIRED", tool: "init_goal" });
  assert.equal(detectPhaseFromFiles({ hasRules: true, hasConfig: false, hasBenchmarkScript: true }), "needs_init");
  assertProtocol(composeResearchPhaseResumeMessage(state, options), { marker: "RESEARCH_INIT_REQUIRED", tool: "init_goal" });
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
  assert.equal(state.phase, "looping");
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
