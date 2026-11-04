import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  composeResearchResumeMessage,
  composeResearchSystemPrompt,
  startResearchActivation,
  syncResearchPhaseFromResearchFiles,
} from "../../extensions/pi-goal/protocol/research-protocol.ts";
import { readResearchFileContract } from "../../extensions/pi-goal/persistence/research-files.ts";
import { createResearchPhaseState, onResearchRunFinished } from "../../extensions/pi-goal/protocol/research-phase.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
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

    syncResearchPhaseFromResearchFiles(loop, contract, createResearchState());

    assert.equal(loop.mode, true);
    assert.equal(loop.phase, "needs_init");
    assert.match(composeResearchSystemPrompt(loop, contract, options), /Required action: goal files exist but no contract exists/);
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

    assert.equal(loop.phase, "framing");
    assert.equal(decision.notification, "Research mode ON — rules loaded from goal.md");
    assert.match(decision.kickoff, /frame_goal/);
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

  assert.equal(runtime.loop.phase, "awaiting_log");
  assert.match(composeResearchResumeMessage(runtime, options), /RESEARCH_LOG_REQUIRED/);
});
