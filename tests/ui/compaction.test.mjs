import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  researchSummaryPathsFor,
  buildResearchCompactionSummary,
} from "../../extensions/pi-goal/support/compaction.ts";
import { ensureActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";

function withTempWorkDir(fn) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-compact-"));
  try {
    fn(dir, ensureActiveResearch(dir).paths.directory);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJournalLines(researchDir, lines) {
  fs.writeFileSync(path.join(researchDir, "goal.jsonl"), lines.join("\n") + "\n");
}

test("summary contains all persisted sources when present", () => {
  withTempWorkDir((workDir, researchDir) => {
    fs.writeFileSync(path.join(researchDir, "goal.md"), "# Rules\nDo not cheat.");
    fs.writeFileSync(path.join(researchDir, "goal.ideas.md"), "- Try memoization\n- Try parallelism");
    writeJournalLines(researchDir, [
      '{"type":"config","name":"Speed up parser","metricName":"total_us","metricUnit":"us","bestDirection":"lower"}',
      '{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"baseline","timestamp":1,"metrics":{},"asi":{"hypothesis":"start point"}}',
      '{"run":2,"commit":"bbb2222","metric":80,"status":"keep","description":"cache foo","timestamp":2,"metrics":{},"asi":{"hypothesis":"memoize repeated keys","next_action_hint":"try LRU"}}',
      '{"run":3,"commit":"ccc3333","metric":120,"status":"discard","description":"tried lru-cache","timestamp":3,"metrics":{},"asi":{"rollback_reason":"import overhead"}}',
    ]);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.match(summary, /# Research Compaction Summary/);
    assert.match(summary, /## Research/);
    assert.match(summary, /Goal: Speed up parser/);
    assert.match(summary, /Metric: total_us — lower is better/);
    assert.match(summary, /Runs so far: 3 \(2 keep · 1 discard\)/);
    assert.match(summary, /Baseline \(#1\): 100us/);
    assert.match(summary, /Best\s+\(#2\): 80us \(-20\.0%\)/);
    assert.match(summary, /## Research Rules \(goal\.md\)/);
    assert.match(summary, /Do not cheat\./);
    assert.match(summary, /## Ideas Backlog \(goal\.ideas\.md\)/);
    assert.match(summary, /Try memoization/);
    assert.match(summary, /## Recent Runs \(last 3\)/);
    assert.match(summary, /#1 keep/);
    assert.match(summary, /#2 keep\s+80 \(-20\.0%\)/);
    assert.match(summary, /#3 discard\s+120 \(\+20\.0%\)/);
    assert.match(summary, /hyp: memoize repeated keys/);
    assert.match(summary, /next: try LRU/);
    assert.match(summary, /rollback: import overhead/);
    assert.match(summary, /## Next Step/);
    assert.match(summary, /If you need more details, read additional lines from goal\.jsonl\./);
  });
});

test("research block omits baseline/best when no runs exist yet", () => {
  withTempWorkDir((workDir, researchDir) => {
    writeJournalLines(researchDir, [
      '{"type":"config","name":"Cold start","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
    ]);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.match(summary, /Goal: Cold start/);
    assert.match(summary, /Runs so far: 0/);
    assert.doesNotMatch(summary, /Baseline/);
    assert.doesNotMatch(summary, /Best\s+\(#/);
  });
});

test("research block reflects current experimentIndex after re-init", () => {
  withTempWorkDir((workDir, researchDir) => {
    writeJournalLines(researchDir, [
      '{"type":"config","name":"Old goal","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"a","metric":500,"status":"keep","description":"old baseline","timestamp":1,"metrics":{}}',
      '{"type":"config","name":"New goal","metricName":"bytes","metricUnit":"kb","bestDirection":"higher"}',
      '{"run":2,"commit":"b","metric":10,"status":"keep","description":"new baseline","timestamp":2,"metrics":{}}',
      '{"run":3,"commit":"c","metric":15,"status":"keep","description":"better","timestamp":3,"metrics":{}}',
    ]);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.match(summary, /Goal: New goal/);
    assert.match(summary, /Metric: bytes — higher is better/);
    assert.match(summary, /Runs so far: 2 \(2 keep\)/);
    assert.match(summary, /Baseline \(#2\): 10kb/);
    assert.match(summary, /Best\s+\(#3\): 15kb \(\+50\.0%\)/);
  });
});

test("summary degrades gracefully when no files exist", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-compact-"));
  try {
    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(dir));

    assert.match(summary, /# Research Compaction Summary/);
    assert.match(summary, /## Research/);
    assert.match(summary, /Goal: —/);
    assert.match(summary, /Runs so far: 0/);
    assert.doesNotMatch(summary, /## Research Rules/);
    assert.doesNotMatch(summary, /## Ideas Backlog/);
    assert.match(summary, /No runs yet/);
    assert.match(summary, /## Next Step/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summary keeps only the last 50 runs", () => {
  withTempWorkDir((workDir, researchDir) => {
    const lines = ['{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}'];
    for (let i = 1; i <= 75; i++) {
      lines.push(`{"run":${i},"commit":"c${i}","metric":${100 + i},"status":"keep","description":"r${i}","timestamp":${i},"metrics":{}}`);
    }
    writeJournalLines(researchDir, lines);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.match(summary, /## Recent Runs \(last 50\)/);
    assert.doesNotMatch(summary, /#25 keep/);
    assert.match(summary, /#26 keep/);
    assert.match(summary, /#75 keep/);
  });
});

test("recent run deltas use the full experimentIndex baseline even when baseline is hidden", () => {
  withTempWorkDir((workDir, researchDir) => {
    const lines = ['{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}'];
    for (let i = 1; i <= 75; i++) {
      lines.push(`{"run":${i},"commit":"c${i}","metric":${100 - i},"status":"keep","description":"r${i}","timestamp":${i},"metrics":{}}`);
    }
    writeJournalLines(researchDir, lines);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.doesNotMatch(summary, /#1 keep/);
    assert.match(summary, /#51 keep\s+49 \(-50\.5%\)/);
    assert.match(summary, /#75 keep\s+25 \(-74\.7%\)/);
  });
});

test("delta is computed against the first run of the same experiment", () => {
  withTempWorkDir((workDir, researchDir) => {
    writeJournalLines(researchDir, [
      '{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":1,"commit":"a","metric":200,"status":"keep","description":"experiment0 base","timestamp":1,"metrics":{}}',
      '{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}',
      '{"run":2,"commit":"b","metric":100,"status":"keep","description":"experiment1 base","timestamp":2,"metrics":{}}',
      '{"run":3,"commit":"c","metric":80,"status":"keep","description":"experiment1 better","timestamp":3,"metrics":{}}',
    ]);

    const summary = buildResearchCompactionSummary(researchSummaryPathsFor(workDir));

    assert.match(summary, /#2 keep\s+100 \| desc: experiment1 base/);
    assert.match(summary, /#3 keep\s+80 \(-20\.0%\) \| desc: experiment1 better/);
    assert.match(summary, /#1 keep\s+200 \| desc: experiment0 base/);
  });
});
