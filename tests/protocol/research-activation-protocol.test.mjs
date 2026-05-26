import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  composeResearchResumeMessage,
  composeResearchSystemPrompt,
  decidePendingResearchResume,
  onResearchResumeDelivered,
  shouldResumeResearchAfterTurn,
  startResearchActivation,
  syncResearchPhaseFromResearchFiles,
} from "../../extensions/pi-goal/protocol/research-protocol.ts";
import { readResearchFileContract } from "../../extensions/pi-goal/persistence/research-files.ts";
import { createResearchPhaseState, onResearchRunFinished } from "../../extensions/pi-goal/protocol/research-phase.ts";
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { ensureActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";

const options = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

test("activation protocol enters needs_init when rules and script exist without config", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-activation-"));
  try {
    const researchDir = ensureActiveResearch(projectDir).paths.directory;
    fs.writeFileSync(path.join(researchDir, "goal.md"), "# Goal\n");
    fs.writeFileSync(path.join(researchDir, "goal.sh"), "#!/usr/bin/env bash\n");
    const contract = readResearchFileContract(projectDir);
    const loop = createResearchPhaseState();

    syncResearchPhaseFromResearchFiles(loop, contract);

    assert.equal(loop.mode, true);
    assert.equal(loop.phase, "needs_init");
    assert.match(composeResearchSystemPrompt(loop, contract, options), /Required action: goal files exist but no config header exists/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("activation protocol composes kickoff and notification from file contract", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-activation-"));
  try {
    const researchDir = ensureActiveResearch(projectDir).paths.directory;
    fs.writeFileSync(path.join(researchDir, "goal.md"), "# Goal\n");
    fs.writeFileSync(path.join(researchDir, "goal.sh"), "#!/usr/bin/env bash\n");
    const contract = readResearchFileContract(projectDir);
    const loop = createResearchPhaseState();

    const decision = startResearchActivation(loop, contract, "optimize tests", options);

    assert.equal(loop.phase, "needs_init");
    assert.equal(decision.notification, "Research mode ON — rules loaded from goal.md");
    assert.match(decision.kickoff, /Read goal\.md, then call init_goal/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("activation protocol owns after-turn resume gate and message", () => {
  const runtime = createSessionRuntime();
  onResearchRunFinished(runtime.loop, {
    command: "bash goal.sh",
    passed: true,
    crashed: false,
    timedOut: false,
    checksPass: true,
    checksTimedOut: false,
    parsedPrimary: 42,
    parsedMetrics: { total_ms: 42 },
    metricName: "total_ms",
    metricUnit: "ms",
  });

  assert.equal(shouldResumeResearchAfterTurn(runtime, options), true);
  assert.match(composeResearchResumeMessage(runtime, options), /RESEARCH_LOG_REQUIRED/);
});

test("activation protocol decides pending resume delivery and updates counters", () => {
  const runtime = createSessionRuntime();
  runtime.loop.mode = true;
  runtime.loop.pendingResumeMessage = "continue";

  assert.deepEqual(decidePendingResearchResume(runtime, options, false), { action: "wait" });
  assert.deepEqual(decidePendingResearchResume(runtime, options, true), { action: "deliver", message: "continue" });

  onResearchResumeDelivered(runtime);

  assert.equal(runtime.loop.pendingResumeMessage, null);
  assert.equal(runtime.loop.autoResumeTurns, 1);
});
