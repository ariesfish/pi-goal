import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createSessionRuntime } from "../extensions/pi-goal/support/runtime.ts";
import { executeRunExperimentWorkflow } from "../extensions/pi-goal/run-experiment-workflow.ts";
import { onResearchRunFinished } from "../extensions/pi-goal/protocol/research-phase.ts";
import { activeResearch, selectActiveResearch } from "../extensions/pi-goal/persistence/research-directory.ts";

function tempProject() {
  return fs.mkdtempSync(path.join(tmpdir(), "pi-goal-run-workflow-"));
}

function piExec() {
  return {
    async exec() {
      return { code: 0, killed: false, stdout: "", stderr: "" };
    },
  };
}

test("run experiment workflow blocks a second Run until the previous Run Result is logged", async () => {
  const workDir = tempProject();
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
  const workDir = tempProject();
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
  const workDir = tempProject();
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
