import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { recordGate } from "../../extensions/pi-goal/workflows/gate-workflow.ts";
import { recordReview } from "../../extensions/pi-goal/workflows/review-workflow.ts";
import {
  createFakePiExec,
  journalPath,
  readJournalEntries,
  tempProject,
} from "../helpers/research-fixture.mjs";

const contract = {
  version: 1,
  objective: "cut test time",
  criteria: [
    {
      id: "C1",
      statement: "suite faster",
      kind: "metric",
      blocking: true,
      metric: { name: "total_ms", direction: "lower" },
    },
  ],
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

function newState() {
  const state = createResearchState();
  state.name = "Speed";
  state.metricName = "total_ms";
  state.metricUnit = "ms";
  state.bestDirection = "lower";
  state.contract = contract;
  return state;
}

function fakePi(execHandler = {}) {
  const { calls, pi } = createFakePiExec(execHandler);
  return { pi, calls };
}

function breakingJournal(projectDir) {
  fs.mkdirSync(journalPath(projectDir), { recursive: true });
}

test("recordGate journals its verdict and holds it on the state", async () => {
  const projectDir = tempProject("pi-goal-gate-seam");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    const { pi } = fakePi();

    const recording = await recordGate({
      pi,
      workDir: projectDir,
      contract,
      state,
      metric: 90,
    });

    assert.equal(recording.recorded, true);
    assert.equal(recording.gate.verdict, "pass");
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].verdict, "pass");

    const entries = readJournalEntries(projectDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "gate");
    assert.equal(entries[0].gate.verdict, "pass");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("recordGate reports a journal failure and leaves the state untouched", async () => {
  const projectDir = tempProject("pi-goal-gate-seam");
  try {
    selectActiveResearch(projectDir, "default");
    breakingJournal(projectDir);
    const state = newState();
    const { pi } = fakePi();

    const recording = await recordGate({
      pi,
      workDir: projectDir,
      contract,
      state,
      metric: 90,
    });

    assert.equal(recording.recorded, false);
    assert.match(recording.text, /Failed to write goal\.jsonl/);
    assert.equal(state.gates.length, 0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("recordGate reuses caller-supplied changed paths instead of re-reading git", async () => {
  const projectDir = tempProject("pi-goal-gate-seam");
  try {
    selectActiveResearch(projectDir, "default");
    const state = newState();
    const { pi, calls } = fakePi();

    await recordGate({
      pi,
      workDir: projectDir,
      contract,
      state,
      metric: 90,
      changedPaths: [],
    });

    assert.equal(
      calls.some(([command, args]) => command === "git" && args[0] === "status"),
      false,
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("recordReview journals its findings and holds them on the state", async () => {
  const projectDir = tempProject("pi-goal-review-seam");
  try {
    selectActiveResearch(projectDir, "default");
    const script = path.join(projectDir, "reviewer.mjs");
    fs.writeFileSync(
      script,
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write('{\"findings\":[]}'); });",
      ].join("\n"),
    );
    const state = newState();
    const { pi } = fakePi();

    const recording = await recordReview({
      pi,
      workDir: projectDir,
      contract,
      state,
      reviewer: { kind: "command", command: process.execPath, args: [script], timeoutSeconds: 10 },
      changedPaths: [],
    });

    assert.equal(recording.recorded, true);
    assert.equal(recording.result.review.findings.length, 0);
    assert.equal(state.reviews.length, 1);

    const entries = readJournalEntries(projectDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "review");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
