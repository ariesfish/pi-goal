import assert from "node:assert/strict";
import test from "node:test";

import {
  activateLoop,
  composeResumeMessage,
  createLoopControllerState,
  detectPhaseFromFiles,
  awaitingLogBlockMessage,
  onInitExperiment,
  onLogExperiment,
  onRunExperimentFinished,
  shouldAutoResumeAfterTurn,
  shouldBlockRunExperiment,
  systemPromptFor,
} from "../extensions/pi-goal/loop-controller.ts";

const options = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

test("activation without config enters setup phase and emits mandatory protocol", () => {
  const state = createLoopControllerState();
  const message = activateLoop(state, {
    userGoal: "optimize tests",
    hasRules: false,
    hasConfig: false,
    hasBenchmarkScript: false,
  }, options);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "activating");
  assert.match(message, /RESEARCH_ACTIVATION_REQUIRED/);
  assert.match(message, /Call init_goal/);
  assert.equal(shouldAutoResumeAfterTurn(state, options), true);
});

test("existing goal files without config enter needs_init", () => {
  const state = createLoopControllerState();
  const message = activateLoop(state, {
    userGoal: "resume",
    hasRules: true,
    hasConfig: false,
    hasBenchmarkScript: true,
  }, options);

  assert.equal(state.phase, "needs_init");
  assert.match(message, /Read goal\.md, then call init_goal/);
  assert.equal(detectPhaseFromFiles({ hasRules: true, hasConfig: false, hasBenchmarkScript: true }), "needs_init");
  assert.match(composeResumeMessage(state, options), /RESEARCH_INIT_REQUIRED/);
});

test("init_goal transitions to mandatory baseline phase", () => {
  const state = createLoopControllerState();

  onInitExperiment(state);

  assert.equal(state.mode, true);
  assert.equal(state.phase, "needs_baseline");
  assert.equal(shouldAutoResumeAfterTurn(state, options), true);
  assert.match(composeResumeMessage(state, options), /RESEARCH_BASELINE_REQUIRED/);
});

test("run_goal transitions to awaiting_log and blocks another run", () => {
  const state = createLoopControllerState();

  onRunExperimentFinished(state, {
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
  assert.equal(shouldAutoResumeAfterTurn(state, options), true);
  assert.equal(shouldBlockRunExperiment(state), true);
  assert.match(awaitingLogBlockMessage(state), /Previous run_goal has not been logged/);
  assert.match(awaitingLogBlockMessage(state), /status: "checks_failed"/);
  assert.match(awaitingLogBlockMessage(state), /metric: 123/);
});

test("log_goal transitions from awaiting_log to looping or limit reached", () => {
  const state = createLoopControllerState();
  onRunExperimentFinished(state, {
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

  onLogExperiment(state, false);
  assert.equal(state.phase, "looping");
  assert.equal(state.mode, true);
  assert.equal(state.lastRun, null);
  assert.equal(shouldAutoResumeAfterTurn(state, options), true);

  onLogExperiment(state, true);
  assert.equal(state.phase, "limit_reached");
  assert.equal(state.mode, false);
});

test("system prompt injects phase-specific required action", () => {
  const state = createLoopControllerState();
  onInitExperiment(state);

  const prompt = systemPromptFor(state, {
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
  assert.match(prompt, /Required action: run the baseline now/);
  assert.match(prompt, /Backpressure Checks/);
  assert.match(prompt, /Ideas backlog/);
});
