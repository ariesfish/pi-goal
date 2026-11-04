import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { beginResearchFraming } from "../../extensions/pi-goal/protocol/research-phase.ts";
import {
  executeFrameGoal,
  executeFreezeCriteria,
  executeProbeGoal,
} from "../../extensions/pi-goal/workflows/goal-contract-workflow.ts";
import { recordRunResult } from "../../extensions/pi-goal/workflows/research-workflow.ts";
import { finishRecordedRunResult } from "../../extensions/pi-goal/workflows/run-result-recording.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { researchStateFromJournal } from "../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { journalPath } from "../helpers/research-fixture.mjs";

const run = promisify(execFile);
const transcript = [];
const log = (line) => {
  transcript.push(line);
  console.log(line);
};

const pi = {
  async exec(command, args, options = {}) {
    try {
      const result = await run(command, args, { cwd: options.cwd });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? String(error.message),
      };
    }
  },
};

async function git(cwd, args) {
  return (await run("git", args, { cwd })).stdout.trim();
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e-"));
  try {
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "e2e@example.com"]);
    await git(dir, ["config", "user.name", "E2E"]);
    fs.writeFileSync(path.join(dir, "src.txt"), "base\n");
    fs.writeFileSync(
      path.join(dir, "check.js"),
      [
        "const fs = require('node:fs');",
        "if (fs.readFileSync('src.txt', 'utf8').includes('broken')) {",
        "  console.error('broken state');",
        "  process.exit(1);",
        "}",
      ].join("\n"),
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "setup"]);

    selectActiveResearch(dir, "default");
    const runtime = createSessionRuntime();
    beginResearchFraming(runtime.loop);
    log(`phase=${runtime.loop.phase}`);

    const frame = executeFrameGoal({
      directions: [
        {
          id: "D1",
          title: "share fixture setup",
          mechanism: "one setup for all test files",
          proxyMetric: "total_ms",
          cost: "1 day",
          risk: "shared state leaks",
          killIf: "any test becomes order dependent",
        },
        {
          id: "D2",
          title: "run test files in workers",
          mechanism: "process-level parallelism",
          proxyMetric: "total_ms",
          cost: "2 days",
          risk: "flaky ordering",
          killIf: "workers change failure modes",
        },
      ],
    }, { runtime, workDir: dir, confirm: async () => true });
    assert.equal(frame.ok, true);
    log(`frame -> phase=${runtime.loop.phase}, directions=${runtime.state.directions.length}`);

    const probe1 = await executeProbeGoal({
      direction_id: "D1",
      command: "node -e \"console.log('METRIC total_ms=9000')\"",
      decision: "keep",
    }, { runtime, workDir: dir, confirm: async () => true });
    assert.equal(probe1.ok, true);
    log(`probe D1 -> ${runtime.state.directions[0].status} value=${runtime.state.directions[0].evidence.value}`);

    const probe2 = await executeProbeGoal({
      direction_id: "D2",
      command: "node -e \"console.log('METRIC total_ms=12000')\"",
      decision: "kill",
    }, { runtime, workDir: dir, confirm: async () => true });
    assert.equal(probe2.ok, true);
    log(`probe D2 -> ${runtime.state.directions[1].status}, phase=${runtime.loop.phase}`);

    const freeze = await executeFreezeCriteria({
      name: "E2E Speed",
      objective: "cut test time without weakening checks",
      criteria: [
        {
          id: "C1",
          statement: "suite faster than baseline",
          kind: "metric",
          blocking: true,
          metric: { name: "total_ms", direction: "lower", unit: "ms" },
        },
        {
          id: "C2",
          statement: "check passes",
          kind: "command",
          blocking: true,
          check: { command: "node check.js", expect: "exit0" },
        },
      ],
      test_globs: ["**/*.test.*"],
      scope_globs: ["src.txt", "check.js"],
    }, { runtime, workDir: dir, confirm: async () => true, exec: pi });
    assert.equal(freeze.ok, true);
    log(`freeze -> phase=${runtime.loop.phase}, hash=${runtime.state.contract.hash.slice(0, 20)}…`);

    const deps = {
      pi,
      workDir: dir,
      state: runtime.state,
      lastRunChecks: null,
      wallClockSeconds: 1,
      async fireHook() { return null; },
      buildResearchSnapshot(state) {
        return {
          metric_name: state.metricName,
          metric_unit: state.metricUnit,
          direction: state.bestDirection,
          baseline_metric: state.bestMetric,
          best_metric: state.bestMetric,
          run_count: state.results.length,
          goal: state.name ?? "",
        };
      },
      broadcastDashboardUpdate() {},
    };

    const baseline = await recordRunResult({
      commit: "pending",
      metric: 100,
      status: "keep",
      description: "baseline",
      asi: { hypothesis: "baseline" },
    }, deps);
    assert.equal(baseline.ok, true);
    finishRecordedRunResult(runtime, false);
    log(`baseline kept -> phase=${runtime.loop.phase}, runs=${runtime.state.results.length}`);

    fs.writeFileSync(path.join(dir, "src.txt"), "broken\n");
    const blocked = await recordRunResult({
      commit: "pending",
      metric: 90,
      status: "keep",
      description: "faster but breaks the check",
    }, deps);
    assert.equal(blocked.ok, false);
    assert.match(blocked.text, /Gate failed/);
    log(`unsafe keep blocked: ${blocked.text.split("\n")[1]}`);

    const discarded = await recordRunResult({
      commit: "pending",
      metric: 90,
      status: "discard",
      description: "faster but breaks the check",
      asi: { hypothesis: "skip fixtures", rollback_reason: "check failed" },
    }, deps);
    assert.equal(discarded.ok, true);
    finishRecordedRunResult(runtime, false);
    assert.equal(fs.readFileSync(path.join(dir, "src.txt"), "utf-8"), "base\n");
    const attempts = fs.readdirSync(path.join(dir, ".goal/researches/default/attempts"));
    assert.deepEqual(attempts, ["2.patch"]);
    log(`discard reverted to checkpoint; attempt patch=${attempts[0]}`);

    fs.writeFileSync(path.join(dir, "src.txt"), "fast\n");
    const kept = await recordRunResult({
      commit: "pending",
      metric: 80,
      status: "keep",
      description: "share fixture setup",
      asi: { hypothesis: "shared setup" },
    }, deps);
    assert.equal(kept.ok, true);
    finishRecordedRunResult(runtime, false);
    assert.equal(runtime.loop.phase, "sealed");
    const message = await git(dir, ["log", "-1", "--pretty=%B"]);
    assert.match(message, /Criteria: C1,C2/);
    assert.match(message, /Gate: sha256:/);
    log(`keep landed -> phase=${runtime.loop.phase}, runs=${runtime.state.results.length}`);
    log(`commit trailers: ${message.split("\n").slice(-2).join(" | ")}`);

    const replayed = researchStateFromJournal(fs.readFileSync(journalPath(dir), "utf-8"));
    assert.equal(replayed.contract.criteria.length, 2);
    assert.equal(replayed.directions.length, 2);
    assert.equal(replayed.probes.length, 2);
    assert.equal(replayed.attempts.length, 1);
    assert.equal(replayed.gates.length, 3);
    assert.equal(replayed.results.length, 3);
    log(
      `replay -> contract=${replayed.contract.criteria.length} criteria, directions=${replayed.directions.length}, probes=${replayed.probes.length}, gates=${replayed.gates.length}, attempts=${replayed.attempts.length}, runs=${replayed.results.length}`,
    );

    log("E2E PASS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  transcript.push(`E2E FAIL: ${error.stack ?? error}`);
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  const evidenceDir = path.resolve(".dev/audit/evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "e2e-protocol.txt"), transcript.join("\n") + "\n");
});
