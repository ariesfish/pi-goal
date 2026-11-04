import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  commitKeptRunResult,
  readCheckpoint,
  restoreRejectedRunResult,
} from "../../extensions/pi-goal/workspace/research-workspace.ts";

const run = promisify(execFile);

async function git(cwd, args) {
  const result = await run("git", args, { cwd });
  return result.stdout.trim();
}

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

async function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-goal-tx-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

test("a rejected run resets to the checkpoint, keeps the patch, and preserves goal files", async () => {
  const dir = await repo();
  try {
    const attemptsDir = path.join(dir, ".goal/researches/default/attempts");
    const checkpoint = await readCheckpoint(pi, dir);

    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");
    fs.writeFileSync(path.join(dir, "goal.md"), "# kept\n");

    const result = await restoreRejectedRunResult({
      pi,
      workDir: dir,
      status: "discard",
      runNumber: 2,
      description: "tried workers",
      attemptsDir,
    });

    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "base\n");
    assert.equal(fs.existsSync(path.join(dir, "b.txt")), false);
    assert.equal(fs.readFileSync(path.join(dir, "goal.md"), "utf-8"), "# kept\n");

    const patchPath = path.join(attemptsDir, "2.patch");
    assert.equal(fs.existsSync(patchPath), true);
    const patch = fs.readFileSync(patchPath, "utf-8");
    assert.match(patch, /\+changed/);

    assert.equal(result.attempt?.checkpoint, checkpoint);
    assert.equal(result.attempt?.status, "discard");
    assert.equal(result.attempt?.patchPath, patchPath);
    assert.match(result.text, /attempt diff kept/);
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), checkpoint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a kept run commits only the candidate with gate and criteria trailers", async () => {
  const dir = await repo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "faster\n");
    const result = await commitKeptRunResult({
      pi,
      workDir: dir,
      description: "shared fixture setup",
      metricName: "total_ms",
      metric: 90,
      status: "keep",
      secondaryMetrics: { compile_ms: 20 },
      criteriaIds: ["C1", "C2"],
      gateHash: "sha256:gate",
    });

    assert.equal(result.commit !== null, true);
    const message = await git(dir, ["log", "-1", "--pretty=%B"]);
    assert.match(message, /shared fixture setup/);
    assert.match(message, /Result: \{.*total_ms.*90/);
    assert.match(message, /Gate: sha256:gate/);
    assert.match(message, /Criteria: C1,C2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the attempt patch is empty when nothing changed", async () => {
  const dir = await repo();
  try {
    const attemptsDir = path.join(dir, ".goal/researches/default/attempts");
    const result = await restoreRejectedRunResult({
      pi,
      workDir: dir,
      status: "crash",
      runNumber: 1,
      description: "crashed before changing anything",
      attemptsDir,
    });

    assert.equal(result.attempt?.patchPath, path.join(attemptsDir, "1.patch"));
    assert.equal(fs.existsSync(path.join(attemptsDir, "1.patch")), true);
    assert.equal(fs.readFileSync(path.join(attemptsDir, "1.patch"), "utf-8"), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
