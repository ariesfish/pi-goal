import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runReview } from "../../extensions/pi-goal/workflows/review-workflow.ts";
import { createResearchState } from "../../extensions/pi-goal/domain/research-state.ts";

const run = promisify(execFile);

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
  testGlobs: ["**/*.test.*"],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

async function repoWithDiff() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-review-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  return dir;
}

function reviewerScript(dir, findings) {
  const script = path.join(dir, "reviewer.mjs");
  fs.writeFileSync(
    script,
    [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify({ findings }))});`,
      "});",
    ].join("\n"),
  );
  return script;
}

function state() {
  const value = createResearchState();
  value.metricName = "total_ms";
  value.contract = contract;
  return value;
}

test("a reproduced blocking finding denies the keep", async () => {
  const dir = await repoWithDiff();
  try {
    const script = reviewerScript(dir, [
      {
        id: "F1",
        severity: "blocking",
        claim: "shared fixture leaks state",
        repro: { kind: "command", payload: "exit 1" },
      },
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { command: process.execPath, args: [script], blocking: true, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
    });

    assert.equal(result.review.findings[0].reproduced, true);
    assert.equal(result.deniedKeep, true);
    assert.match(result.text, /reproduced/);
    assert.equal(result.precision.blockingFindings, 1);
    assert.equal(result.precision.reproducedFindings, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a finding whose repro passes is advisory and does not deny keep", async () => {
  const dir = await repoWithDiff();
  try {
    const script = reviewerScript(dir, [
      {
        id: "F1",
        severity: "blocking",
        claim: "false alarm",
        repro: { kind: "command", payload: "exit 0" },
      },
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { command: process.execPath, args: [script], blocking: true, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
    });

    assert.equal(result.review.findings[0].reproduced, false);
    assert.equal(result.deniedKeep, false);
    assert.match(result.text, /not reproduced/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a finding without a repro stays advisory", async () => {
  const dir = await repoWithDiff();
  try {
    const script = reviewerScript(dir, [
      { id: "F1", severity: "advisory", claim: "style nit" },
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { command: process.execPath, args: [script], blocking: true, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
    });

    assert.equal(result.review.findings[0].reproduced, false);
    assert.equal(result.deniedKeep, false);
    assert.equal(result.precision.rate, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer blocking off never denies keep", async () => {
  const dir = await repoWithDiff();
  try {
    const script = reviewerScript(dir, [
      {
        id: "F1",
        severity: "blocking",
        claim: "real bug",
        repro: { kind: "command", payload: "exit 1" },
      },
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { command: process.execPath, args: [script], blocking: false, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
    });

    assert.equal(result.review.findings[0].reproduced, true);
    assert.equal(result.deniedKeep, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed reviewer output throws", async () => {
  const dir = await repoWithDiff();
  try {
    const script = path.join(dir, "bad-reviewer.mjs");
    fs.writeFileSync(script, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not json'));");

    await assert.rejects(
      () => runReview({
        pi,
        workDir: dir,
        contract,
        state: state(),
        reviewer: { command: process.execPath, args: [script], blocking: true, timeoutSeconds: 10 },
        changedPaths: ["a.txt"],
      }),
      /not JSON/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
