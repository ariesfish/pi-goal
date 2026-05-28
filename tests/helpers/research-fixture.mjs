import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { activeResearch, selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
export { activeResearch };
import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";

export async function withTempResearch(prefix, fn, options = {}) {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), `pi-goal-${prefix}-`));
  try {
    if (options.selectActiveResearch !== false) {
      selectActiveResearch(workDir, options.identity ?? "default");
    }
    return await fn(workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function journalPath(workDir) {
  return activeResearch(workDir).paths.journal;
}

export function readJournalEntries(workDir) {
  const content = fs.readFileSync(journalPath(workDir), "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

export function appendConfigEntry(workDir, overrides = {}) {
  const entry = {
    type: "config",
    name: "Speed",
    metricName: "total_ms",
    metricUnit: "ms",
    bestDirection: "lower",
    ...overrides,
  };
  fs.mkdirSync(path.dirname(journalPath(workDir)), { recursive: true });
  fs.appendFileSync(journalPath(workDir), JSON.stringify(entry) + "\n");
  return entry;
}

export function appendRunEntry(workDir, overrides = {}) {
  const entry = {
    run: 1,
    commit: "abc1234",
    metric: 100,
    metrics: {},
    status: "keep",
    description: "baseline",
    timestamp: 1,
    experimentIndex: 0,
    confidence: null,
    ...overrides,
  };
  fs.mkdirSync(path.dirname(journalPath(workDir)), { recursive: true });
  fs.appendFileSync(journalPath(workDir), JSON.stringify(entry) + "\n");
  return entry;
}

export function createRuntimeWithMetric(overrides = {}) {
  const runtime = createSessionRuntime();
  runtime.state.name = overrides.name ?? "Speed";
  runtime.state.metricName = overrides.metricName ?? "total_ms";
  runtime.state.metricUnit = overrides.metricUnit ?? "ms";
  runtime.state.bestDirection = overrides.bestDirection ?? "lower";
  return runtime;
}

export function createFakePiExec(handler = {}) {
  const calls = [];
  return {
    calls,
    pi: {
      async exec(command, args = [], options = {}) {
        calls.push([command, args, options]);
        const key = `${command} ${args[0] ?? ""}`.trim();
        if (handler[key]) return handler[key](command, args, options);
        if (handler[command]) return handler[command](command, args, options);
        if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "diff") return { code: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "commit") return { code: 0, stdout: "[main abc1234] kept\n", stderr: "" };
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc1234\n", stderr: "" };
        return { code: 0, killed: false, stdout: "", stderr: "" };
      },
    },
  };
}

export function tempProject(prefix = "pi-goal") {
  return fs.mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

export function assertNoJournal(workDir) {
  assert.equal(fs.existsSync(journalPath(workDir)), false);
}
