import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runShellCommand } from "../../extensions/pi-goal/execution/shell-command-runner.ts";

function options(overrides = {}) {
  return {
    command: "printf hello",
    workDir: tmpdir(),
    timeoutMs: 0,
    getTempFile: () => "/dev/null",
    startedAt: Date.now(),
    ...overrides,
  };
}

test("an already cancelled command rejects before trying to spawn", async () => {
  await assert.rejects(runShellCommand(options({
    signal: AbortSignal.abort(),
    workDir: path.join(tmpdir(), "pi-goal-nonexistent-directory", "missing"),
  })), /aborted/);
});

test("a timeout kills a command that ignores SIGTERM", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-timeout-"));
  const pidPath = path.join(directory, "child.pid");
  fs.writeFileSync(path.join(directory, "child.cjs"), `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync("child.pid", String(process.pid));
    console.log("ready");
    setInterval(() => {}, 1000);
  `);
  let watchdogFired = false;
  const killChild = () => {
    if (fs.existsSync(pidPath)) {
      try { process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const watchdog = setTimeout(() => { watchdogFired = true; killChild(); }, 4000);
  try {
    const result = await runShellCommand(options({
      command: "node child.cjs & wait",
      workDir: directory,
      timeoutMs: 1000,
    }));

    assert.match(result.output, /ready/);
    assert.equal(result.timedOut, true);
    assert.equal(watchdogFired, false, "timeout needed external cleanup to stop the process");
  } finally {
    clearTimeout(watchdog);
    killChild();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a timeout returns even when a detached descendant keeps output pipes open", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-detached-timeout-"));
  const pidPath = path.join(directory, "escaped.pid");
  fs.writeFileSync(path.join(directory, "escaped.cjs"), `
    require("node:fs").writeFileSync("escaped.pid", String(process.pid));
    console.log("escaped-ready");
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(directory, "parent.cjs"), `
    require("node:child_process").spawn(process.execPath, ["escaped.cjs"], {
      detached: true, stdio: "inherit",
    });
    setInterval(() => {}, 1000);
  `);
  let watchdogFired = false;
  const killEscaped = () => {
    if (fs.existsSync(pidPath)) {
      try { process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const watchdog = setTimeout(() => { watchdogFired = true; killEscaped(); }, 4000);
  try {
    const result = await runShellCommand(options({
      command: "node parent.cjs",
      workDir: directory,
      timeoutMs: 1000,
    }));

    assert.match(result.output, /escaped-ready/);
    assert.equal(result.timedOut, true);
    assert.equal(watchdogFired, false, "timeout waited for an escaped process to close its pipes");
  } finally {
    clearTimeout(watchdog);
    killEscaped();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation kills a running command and rejects as aborted", async () => {
  const controller = new AbortController();
  const result = runShellCommand(options({
    command: "node -e 'process.on(\"SIGTERM\", () => {}); console.log(\"ready\"); setInterval(() => {}, 1000)'",
    signal: controller.signal,
    timeoutMs: 4000,
    onUpdate(update) {
      if (update.content[0].text.includes("ready")) controller.abort();
    },
  }));

  await assert.rejects(result, /aborted/);
  assert.equal(controller.signal.aborted, true);
});

test("a spawn failure rejects without leaving output timers running", async () => {
  await assert.rejects(runShellCommand(options({
    workDir: path.join(tmpdir(), "pi-goal-nonexistent-directory", "missing"),
    onUpdate() { throw new Error("No update expected"); },
  })), { code: "ENOENT" });
});

test("an output file allocation failure rejects instead of escaping the data handler", async () => {
  await assert.rejects(runShellCommand(options({
    command: "node -e 'process.stdout.write(\"x\".repeat(250000))'",
    getTempFile() { throw new Error("Cannot allocate output log"); },
  })), /Cannot allocate output log/);
});
