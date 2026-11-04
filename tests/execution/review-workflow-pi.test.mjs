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
  criteria: [{ id: "C1", statement: "faster", kind: "metric", blocking: true, metric: { name: "total_ms", direction: "lower" } }],
  testGlobs: [],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-review-pi-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  return dir;
}

function state() {
  const value = createResearchState();
  value.metricName = "total_ms";
  value.contract = contract;
  return value;
}

function fakePi(_dir, scriptLines) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-fake-pi-"));
  const script = path.join(scriptDir, "fake-pi.mjs");
  fs.writeFileSync(script, scriptLines.join("\n"));
  return { command: process.execPath, args: [script] };
}

test("pi reviewer reads payload.json from an isolated cwd and returns findings", async () => {
  const dir = await repo();
  try {
    const command = fakePi(dir, [
      "import fs from 'node:fs';",
      "const payload = JSON.parse(fs.readFileSync('payload.json', 'utf8'));",
      "process.stdout.write(JSON.stringify({ findings: [{",
      "  id: 'F1', severity: 'blocking', claim: payload.objective,",
      "  repro: { kind: 'command', payload: 'exit 1' }",
      "}] }));",
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { kind: "pi", model: "fake/model", blocking: true, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
      piCommand: command,
    });

    assert.equal(result.review.reviewer, "pi:fake/model");
    assert.equal(result.review.findings[0].claim, "cut test time");
    assert.equal(result.review.findings[0].reproduced, true);
    assert.equal(result.deniedKeep, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pi reviewer payload includes untracked files", async () => {
  const dir = await repo();
  try {
    fs.writeFileSync(path.join(dir, "new-file.txt"), "new candidate\n");
    const command = fakePi(dir, [
      "import fs from 'node:fs';",
      "const payload = JSON.parse(fs.readFileSync('payload.json', 'utf8'));",
      "const untracked = payload.untracked.map((entry) => entry.path).join(',');",
      "process.stdout.write(JSON.stringify({ findings: [{",
      "  id: 'F1', severity: 'advisory', claim: untracked",
      "}] }));",
    ]);

    const result = await runReview({
      pi,
      workDir: dir,
      contract,
      state: state(),
      reviewer: { kind: "pi", model: "fake/model", blocking: false, timeoutSeconds: 10 },
      changedPaths: ["a.txt"],
      piCommand: command,
    });

    assert.equal(result.review.findings[0].claim, "new-file.txt");
    assert.equal(result.review.findings[0].reproduced, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command reviewer that exits before reading stdin does not crash", async () => {
  const dir = await repo();
  try {
    const script = path.join(dir, "early-exit.mjs");
    fs.writeFileSync(script, "process.exit(0);");

    await assert.rejects(
      () => runReview({
        pi,
        workDir: dir,
        contract,
        state: state(),
        reviewer: { kind: "command", command: process.execPath, args: [script], blocking: true, timeoutSeconds: 10 },
        changedPaths: ["a.txt"],
      }),
      /Reviewer command failed|not JSON/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
