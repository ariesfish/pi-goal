import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import test from "node:test";

import {
  executeFrameGoal,
  executeFreezeCriteria,
  executeProbeGoal,
} from "../../extensions/pi-goal/workflows/goal-contract-workflow.ts";
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { beginResearchFraming } from "../../extensions/pi-goal/protocol/research-phase.ts";
import { withTempResearch, readJournalEntries, journalPath } from "../helpers/research-fixture.mjs";

const card = (id, overrides = {}) => ({
  id,
  title: `direction ${id}`,
  mechanism: `mechanism ${id}`,
  proxyMetric: "total_ms",
  cost: "one hour",
  risk: "shared state",
  killIf: "tests become order dependent",
  ...overrides,
});

const criteria = [
  {
    id: "C1",
    statement: "suite under 10s",
    kind: "metric",
    blocking: true,
    metric: { name: "total_ms", direction: "lower", unit: "ms" },
  },
  {
    id: "C2",
    statement: "test suite passes",
    kind: "test",
    blocking: true,
    check: { command: "pnpm test", expect: "exit0" },
  },
];

function readEntries(workDir) {
  return fs.existsSync(journalPath(workDir)) ? readJournalEntries(workDir) : [];
}

function setup() {
  const runtime = createSessionRuntime();
  beginResearchFraming(runtime.loop);
  return runtime;
}

test("frame_goal rejects a single direction without writing", async () => {
  await withTempResearch("frame-single", async (workDir) => {
    const runtime = setup();
    const result = executeFrameGoal(
      { directions: [card("D1")] },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, false);
    assert.match(result.text, /at least two/i);
    assert.equal(runtime.loop.phase, "framing");
    assert.deepEqual(readEntries(workDir), []);
  });
});

test("frame_goal records two cards and enters probing", async () => {
  await withTempResearch("frame-two", async (workDir) => {
    const runtime = setup();
    const result = executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, true);
    assert.equal(runtime.loop.phase, "probing");
    assert.equal(runtime.state.directions.length, 2);

    const entries = readEntries(workDir);
    const directions = entries.filter((entry) => entry.type === "direction");
    assert.equal(directions.length, 2);
    assert.deepEqual(directions.map((entry) => entry.direction.id), ["D1", "D2"]);
    assert.equal(directions[0].direction.status, "open");
  });
});

test("probe_goal records value, evidence hash, and closes the direction", async () => {
  await withTempResearch("probe-keep", async (workDir) => {
    const runtime = setup();
    executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );

    const result = await executeProbeGoal(
      {
        direction_id: "D1",
        command: "printf 'METRIC total_ms=9800\\n'",
        decision: "keep",
      },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, true);
    const direction = runtime.state.directions.find((entry) => entry.id === "D1");
    assert.equal(direction.status, "kept");
    assert.equal(direction.evidence.value, 9_800);
    assert.match(direction.evidence.outputHash, /^sha256:[0-9a-f]{64}$/);

    const entries = readEntries(workDir);
    assert.equal(entries.filter((entry) => entry.type === "probe").length, 1);
    assert.equal(entries.filter((entry) => entry.type === "direction").length, 3);
    assert.equal(runtime.loop.phase, "probing");
  });
});

test("probe_goal retains early metrics and hashes the complete output", async () => {
  await withTempResearch("probe-long-output", async (workDir) => {
    const runtime = setup();
    executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );
    const output = "METRIC total_ms=9800\n" + "x".repeat(250000) + "\n";

    const result = await executeProbeGoal(
      {
        direction_id: "D1",
        command: `node -e 'process.stdout.write("METRIC total_ms=9800\\n" + "x".repeat(250000) + "\\n")'`,
        decision: "keep",
      },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, true, result.text);
    const evidence = runtime.state.directions.find((entry) => entry.id === "D1").evidence;
    assert.equal(evidence.value, 9800);
    assert.equal(evidence.outputHash, `sha256:${createHash("sha256").update(output).digest("hex")}`);
  });
});

test("the last closed direction enters converging", async () => {
  await withTempResearch("probe-converge", async (workDir) => {
    const runtime = setup();
    executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );

    await executeProbeGoal(
      { direction_id: "D1", command: "printf 'METRIC total_ms=9800\\n'", decision: "keep" },
      { runtime, workDir, confirm: async () => true },
    );
    await executeProbeGoal(
      { direction_id: "D2", command: "printf 'METRIC total_ms=12000\\n'", decision: "kill" },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(runtime.loop.phase, "converging");
    assert.equal(runtime.state.directions.every((entry) => entry.status === "killed" || entry.status === "kept"), true);
  });
});

test("probe_goal rejects a probe without a measurable value", async () => {
  await withTempResearch("probe-novalue", async (workDir) => {
    const runtime = setup();
    executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );

    const before = readEntries(workDir).length;
    const result = await executeProbeGoal(
      { direction_id: "D1", command: "echo no-metric-here", decision: "keep" },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, false);
    assert.match(result.text, /no value for proxy metric/i);
    assert.equal(readEntries(workDir).length, before);
    assert.equal(runtime.loop.phase, "probing");
  });
});

test("a crashed probe is recorded as killed even when keep was requested", async () => {
  await withTempResearch("probe-crash", async (workDir) => {
    const runtime = setup();
    executeFrameGoal(
      { directions: [card("D1"), card("D2")] },
      { runtime, workDir, confirm: async () => true },
    );

    const result = await executeProbeGoal(
      { direction_id: "D1", command: "exit 3", value: 123, decision: "keep" },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, true);
    assert.match(result.text, /exited 3/);
    assert.equal(runtime.state.directions.find((entry) => entry.id === "D1").status, "killed");
  });
});

test("freeze_criteria rejects a blocking manual criterion before asking", async () => {
  await withTempResearch("freeze-manual", async (workDir) => {
    const runtime = setup();
    let asked = false;
    const result = await executeFreezeCriteria(
      {
        objective: "cut test time",
        criteria: [{ id: "C1", statement: "looks good", kind: "manual", blocking: true }],
      },
      { runtime, workDir, confirm: async () => { asked = true; return true; } },
    );

    assert.equal(result.ok, false);
    assert.equal(asked, false);
    assert.match(result.text, /manual/i);
  });
});

test("freeze_criteria does nothing when the human declines", async () => {
  await withTempResearch("freeze-decline", async (workDir) => {
    const runtime = setup();
    let confirmMessage = "";
    const result = await executeFreezeCriteria(
      { objective: "cut test time", criteria },
      {
        runtime,
        workDir,
        confirm: async (message) => { confirmMessage = message; return false; },
      },
    );

    assert.equal(result.ok, false);
    assert.match(confirmMessage, /Freeze this goal contract/);
    assert.deepEqual(readEntries(workDir), []);
    assert.equal(runtime.loop.phase, "framing");
    assert.equal(runtime.state.contract, null);
  });
});

test("freeze_criteria writes the contract and config entries and moves to baseline", async () => {
  await withTempResearch("freeze-ok", async (workDir) => {
    const runtime = setup();
    const result = await executeFreezeCriteria(
      { name: "Speed", objective: "cut test time", criteria, test_globs: ["**/*.test.*"] },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(result.ok, true);
    assert.match(result.text, /Contract frozen: sha256:/);
    assert.equal(runtime.loop.phase, "needs_baseline");
    assert.equal(runtime.state.metricName, "total_ms");
    assert.equal(runtime.state.metricUnit, "ms");
    assert.equal(runtime.state.bestDirection, "lower");
    assert.equal(runtime.state.contract.criteria.length, 2);

    const entries = readEntries(workDir);
    assert.equal(entries.filter((entry) => entry.type === "contract").length, 1);
    assert.equal(entries.filter((entry) => entry.type === "config").length, 1);
    assert.equal(entries.find((entry) => entry.type === "contract").contract.hash, runtime.state.contract.hash);
  });
});

test("freeze_criteria seals directly when a baseline already exists", async () => {
  await withTempResearch("freeze-sealed", async (workDir) => {
    const runtime = setup();
    runtime.state.results.push({
      commit: "abc1234",
      metric: 100,
      metrics: {},
      status: "keep",
      description: "baseline",
      timestamp: 1,
      experimentIndex: 0,
      confidence: null,
    });

    await executeFreezeCriteria(
      { objective: "cut test time", criteria },
      { runtime, workDir, confirm: async () => true },
    );

    assert.equal(runtime.loop.phase, "sealed");
  });
});

test("freeze_criteria refuses a dirty tree before asking", async () => {
  await withTempResearch("freeze-dirty", async (workDir) => {
    const runtime = setup();
    let asked = false;
    const result = await executeFreezeCriteria(
      { objective: "cut test time", criteria },
      {
        runtime,
        workDir,
        confirm: async () => { asked = true; return true; },
        exec: {
          async exec() {
            return { code: 0, stdout: " M src/app.ts\n", stderr: "" };
          },
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(asked, false);
    assert.match(result.text, /pre-existing non-research changes/);
    assert.deepEqual(readEntries(workDir), []);
  });
});
