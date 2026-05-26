import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  isGoalShCommand,
  parseMetricLines,
  runExperiment,
} from "../../extensions/pi-goal/execution/experiment-runner.ts";

test("parseMetricLines accepts finite metric values and rejects pollution keys", () => {
  const metrics = parseMetricLines([
    "METRIC total_µs=15200",
    "METRIC compile_ms=4.5",
    "METRIC __proto__=1",
    "METRIC bad=NaN",
    "METRIC total_µs=15100",
  ].join("\n"));

  assert.deepEqual(Object.fromEntries(metrics), {
    total_µs: 15100,
    compile_ms: 4.5,
  });
});

test("isGoalShCommand allows only goal.sh as the first real command", () => {
  assert.equal(isGoalShCommand("./goal.sh"), true);
  assert.equal(isGoalShCommand("FOO=bar nice -n 10 bash ./goal.sh"), true);
  assert.equal(isGoalShCommand("/tmp/work/goal.sh --fast"), true);
  assert.equal(isGoalShCommand("node bench.js; ./goal.sh"), false);
  assert.equal(isGoalShCommand("bash other.sh"), false);
});

test("runExperiment returns structured details, parsed metrics, and checks result", async () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-runner-"));
  try {
    fs.writeFileSync(path.join(workDir, "goal.checks.sh"), "#!/usr/bin/env bash\necho checks-ok\n");
    fs.chmodSync(path.join(workDir, "goal.checks.sh"), 0o755);

    const result = await runExperiment({
      command: "printf 'hello\\nMETRIC total_ms=12\\nMETRIC compile_ms=3\\n'",
      workDir,
      metricName: "total_ms",
      metricUnit: "ms",
      pi: {
        async exec(command, args, options) {
          assert.equal(command, "bash");
          assert.equal(args[0], path.join(workDir, "goal.checks.sh"));
          assert.equal(options.cwd, workDir);
          return { code: 0, killed: false, stdout: "checks-ok", stderr: "" };
        },
      },
    });

    assert.equal(result.details.passed, true);
    assert.equal(result.details.checksPass, true);
    assert.equal(result.details.parsedPrimary, 12);
    assert.deepEqual(result.details.parsedMetrics, { total_ms: 12, compile_ms: 3 });
    assert.match(result.llmOutput, /METRIC total_ms=12/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("runExperiment records timed out checks as a failed Run", async () => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-runner-"));
  try {
    fs.writeFileSync(path.join(workDir, "goal.checks.sh"), "#!/usr/bin/env bash\necho slow\n");

    const result = await runExperiment({
      command: "printf 'METRIC total_ms=12\\n'",
      workDir,
      metricName: "total_ms",
      metricUnit: "ms",
      pi: {
        async exec() {
          return { code: null, killed: true, stdout: "", stderr: "timeout" };
        },
      },
    });

    assert.equal(result.details.passed, false);
    assert.equal(result.details.crashed, true);
    assert.equal(result.details.checksPass, false);
    assert.equal(result.details.checksTimedOut, true);
    assert.equal(result.details.parsedPrimary, 12);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
