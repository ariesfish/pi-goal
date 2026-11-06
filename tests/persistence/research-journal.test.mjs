import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { appendHookLogEntryIfConfigured } from "../../extensions/pi-goal/execution/hooks.ts";
import { appendConfigEntry, journalPath, tempProject } from "../helpers/research-fixture.mjs";
import {
  extractResearchName,
  hasResearchConfigHeader,
  isResearchConfigEntry,
  isRunResultEntry,
  parseJournalEntry,
  parseResearchJournal,
} from "../../extensions/pi-goal/persistence/research-journal-codec.ts";

test("hook entries are skipped when identifying run entries", () => {
  const hookEntry = parseJournalEntry('{"type":"hook","stage":"before","exit_code":0}');
  const runEntry = parseJournalEntry('{"run":1,"metric":42}');

  assert.equal(isResearchConfigEntry(hookEntry), false);
  assert.equal(isRunResultEntry(hookEntry), false);
  assert.equal(isRunResultEntry(runEntry), true);
});

test("hook-only jsonl does not count as having a config header", () => {
  const jsonl = '{"type":"hook","stage":"before","exit_code":0}\n';

  assert.equal(hasResearchConfigHeader(jsonl), false);
});

test("session name comes from the first config entry, not the first line", () => {
  const jsonl = [
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"type":"config","name":"Hook-safe session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"run":1,"commit":"abc1234","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{}}',
  ].join("\n");

  assert.equal(hasResearchConfigHeader(jsonl), true);
  assert.equal(extractResearchName(jsonl), "Hook-safe session");
});

test("parseResearchJournal ignores hooks and malformed journal lines while preserving run experiments", () => {
  const jsonl = [
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    'not json',
    '{"run":1,"commit":"aaa1111","metric":10,"status":"keep","description":"baseline","timestamp":1,"metrics":{"compile_ms":4}}',
    '{"type":"hook","stage":"after","exit_code":0}',
    '{"type":"config","name":"Segmented session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}',
    '{"type":"hook","stage":"before","exit_code":0}',
    '{"run":2,"commit":"bbb2222","metric":7,"status":"keep","description":"new baseline","timestamp":2,"metrics":{"render_ms":2}}',
  ].join("\n");

  const { state } = parseResearchJournal(jsonl);

  assert.equal(state.results.length, 2);
  assert.deepEqual(state.results.map((result) => result.metric), [10, 7]);
  assert.deepEqual(state.results.map((result) => result.experimentIndex), [0, 1]);
  assert.equal(state.currentExperimentIndex, 1);
  assert.deepEqual(state.secondaryMetrics.map((metric) => metric.name), ["render_ms"]);
});

test("hook observability does not create jsonl before config exists", () => {
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-hooks-"));
  const jsonlPath = path.join(tempDir, "goal.jsonl");
  const result = {
    fired: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
  };

  try {
    assert.equal(appendHookLogEntryIfConfigured(jsonlPath, "before", result), false);
    assert.equal(fs.existsSync(jsonlPath), false);

    fs.writeFileSync(jsonlPath, '{"type":"hook","stage":"before","exit_code":0}\n');
    assert.equal(appendHookLogEntryIfConfigured(jsonlPath, "after", result), false);
    assert.equal(
      fs.readFileSync(jsonlPath, "utf-8"),
      '{"type":"hook","stage":"before","exit_code":0}\n',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("journal snapshots are reused until the journal changes", async () => {
  const { readJournalSnapshot, appendRunResultToJournal } = await import(
    "../../extensions/pi-goal/persistence/research-journal.ts"
  );
  const { selectActiveResearch } = await import(
    "../../extensions/pi-goal/persistence/research-directory.ts"
  );
  const projectDir = tempProject("pi-goal-snapshot");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);

    const first = readJournalSnapshot(projectDir);
    assert.equal(readJournalSnapshot(projectDir), first);

    appendRunResultToJournal(projectDir, {
      run: 1,
      commit: "abc1234",
      metric: 100,
      status: "keep",
      description: "baseline",
      timestamp: 1,
      experimentIndex: 0,
    });
    const afterAppend = readJournalSnapshot(projectDir);
    assert.notEqual(afterAppend, first);
    assert.equal(afterAppend.state.results.length, 1);

    // An append that bypasses the module still invalidates on file identity.
    fs.appendFileSync(journalPath(projectDir), JSON.stringify({
      run: 2,
      commit: "def5678",
      metric: 90,
      status: "keep",
      description: "faster",
      timestamp: 2,
      experimentIndex: 0,
    }) + "\n");
    const afterExternalAppend = readJournalSnapshot(projectDir);
    assert.notEqual(afterExternalAppend, afterAppend);
    assert.equal(afterExternalAppend.state.results.length, 2);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
