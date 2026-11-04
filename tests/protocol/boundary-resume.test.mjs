import assert from "node:assert/strict";
import test from "node:test";

import { decideBoundaryContinuation } from "../../extensions/pi-goal/protocol/boundary-resume.ts";
import {
  countConsecutiveFailures,
  roundsSinceLastKeep,
} from "../../extensions/pi-goal/protocol/research-guards.ts";
import {
  beginResearchFraming,
  createResearchPhaseState,
  onResearchRunFinished,
} from "../../extensions/pi-goal/protocol/research-phase.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";

const options = {
  maxAutoResumeTurns: 200,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

const run = (status, metric = 100) => ({
  commit: "abc1234",
  metric,
  metrics: {},
  status,
  description: status,
  timestamp: 1,
  experimentIndex: 0,
  confidence: null,
});

function decide(runtime, overrides = {}) {
  return decideBoundaryContinuation({
    runtime,
    options,
    canContinue: true,
    outcome: "completed",
    composeMessage: () => "next action",
    ...overrides,
  });
}

function sealedRuntime(results = []) {
  const runtime = createSessionRuntime();
  runtime.loop.mode = true;
  runtime.loop.phase = "sealed";
  runtime.loop.runsSinceAgentStart = 1;
  runtime.state.results = results;
  return runtime;
}

test("inactive and aborted runs do not continue", () => {
  const runtime = createSessionRuntime();
  assert.deepEqual(decide(runtime), { action: "none" });

  const framed = createSessionRuntime();
  beginResearchFraming(framed.loop);
  assert.deepEqual(decide(framed, { outcome: "aborted" }), { action: "none" });
  assert.deepEqual(decide(framed, { canContinue: false }), { action: "none" });
});

test("framing continues with the phase message", () => {
  const runtime = createSessionRuntime();
  beginResearchFraming(runtime.loop);

  assert.deepEqual(decide(runtime), { action: "continue", message: "next action" });
});

test("awaiting_log continues even without a completed run this turn", () => {
  const runtime = createSessionRuntime();
  onResearchRunFinished(runtime.loop, {
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

  assert.equal(decide(runtime).action, "continue");
});

test("the auto-resume limit stops the loop", () => {
  const runtime = sealedRuntime([run("keep")]);
  runtime.loop.autoResumeTurns = 200;

  const decision = decide(runtime);
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /auto-resume limit/i);
});

test("consecutive failures stop the loop", () => {
  const results = Array.from({ length: 10 }, () => run("crash"));
  const runtime = sealedRuntime(results);

  const decision = decide(runtime);
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /consecutive discards or crashes/i);
  assert.equal(countConsecutiveFailures(results), 10);
});

test("eight rounds without a keep stop the loop", () => {
  const results = [run("keep"), ...Array.from({ length: 8 }, () => run("discard"))];
  const runtime = sealedRuntime(results);

  assert.equal(roundsSinceLastKeep(results, 0), 8);
  const decision = decide(runtime);
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /No progress/i);
});

test("a recent keep keeps the loop going", () => {
  const results = [run("discard"), run("keep"), run("discard"), run("discard")];
  const runtime = sealedRuntime(results);

  assert.equal(roundsSinceLastKeep(results, 0), 2);
  assert.deepEqual(decide(runtime), { action: "continue", message: "next action" });
});
