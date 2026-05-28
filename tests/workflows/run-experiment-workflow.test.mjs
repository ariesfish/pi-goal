import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { executeRunExperimentWorkflow } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { onResearchRunFinished } from "../../extensions/pi-goal/protocol/research-phase.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import {
  tempProject,
  activeResearch,
  createFakePiExec,
} from "../helpers/research-fixture.mjs";

function piExec() {
  return createFakePiExec().pi;
}

test("run experiment workflow blocks a second Run until the previous Run Result is logged", async () => {
  const workDir = tempProject("pi-goal-run-workflow");
  try {
    const runtime = createSessionRuntime();
    onResearchRunFinished(runtime.loop, {
      command: "npm test",
      passed: true,
      crashed: false,
      timedOut: false,
      checksPass: null,
      checksTimedOut: false,
      parsedPrimary: 12,
      parsedMetrics: { total_ms: 12 },
      metricName: "total_ms",
      metricUnit: "ms",
    });

    const result = await executeRunExperimentWorkflow(
      { command: "echo nope" },
      { pi: piExec(), workDir, runtime, onActiveRunChange() {} },
    );

    assert.equal(result.ok, false);
    assert.match(result.text, /Previous run_goal has not been logged/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("run experiment workflow enforces goal.sh when a Research script exists", async () => {
  const workDir = tempProject("pi-goal-run-workflow");
  try {
    const runtime = createSessionRuntime();
    runtime.state.metricName = "total_ms";
    runtime.state.metricUnit = "ms";
    selectActiveResearch(workDir, "default");
    fs.writeFileSync(activeResearch(workDir).paths.script, "#!/usr/bin/env bash\necho ok\n");

    const result = await executeRunExperimentWorkflow(
      { command: "node bench.js" },
      { pi: piExec(), workDir, runtime, onActiveRunChange() {} },
    );

    assert.equal(result.ok, false);
    assert.match(result.text, /goal\.sh exists/);
    assert.equal(result.details?.metricName, "total_ms");
    assert.equal(runtime.activeRun, null);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("run experiment workflow runs command, updates runtime, and enters awaiting_log", async () => {
  const workDir = tempProject("pi-goal-run-workflow");
  try {
    const runtime = createSessionRuntime();
    runtime.state.metricName = "total_ms";
    runtime.state.metricUnit = "ms";
    let activeRunChanges = 0;

    const result = await executeRunExperimentWorkflow(
      { command: "printf 'METRIC total_ms=42\\n'" },
      {
        pi: piExec(),
        workDir,
        runtime,
        onActiveRunChange() { activeRunChanges++; },
      },
    );

    assert.equal(result.ok, true);
    assert.match(result.text, /✅ PASSED/);
    assert.match(result.text, /metric: 42/);
    assert.equal(runtime.activeRun, null);
    assert.equal(runtime.lastRunDuration !== null, true);
    assert.equal(runtime.loop.phase, "awaiting_log");
    assert.equal(runtime.loop.lastRun?.parsedPrimary, 42);
    assert.equal(activeRunChanges, 2);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
