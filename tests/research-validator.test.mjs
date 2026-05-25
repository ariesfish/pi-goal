import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { validateResearch } from "../extensions/pi-goal/research-validator.ts";
import { ensureActiveResearchDirectory } from "../extensions/pi-goal/research-directory.ts";

function writeResearchFiles(projectDir, metricName = "total_ms") {
  const researchDir = ensureActiveResearchDirectory(projectDir);
  fs.writeFileSync(path.join(researchDir, "goal.md"), "# Goal");
  fs.writeFileSync(path.join(researchDir, "goal.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(researchDir, "goal.jsonl"), JSON.stringify({
    type: "config",
    name: "S",
    metricName,
    metricUnit: "ms",
    bestDirection: "lower",
  }) + "\n");
}

test("validator reports missing primary metric from dry run", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-validator-"));
  try {
    writeResearchFiles(dir);

    const result = await validateResearch({
      workDir: dir,
      pi: {
        async exec() {
          return { code: 0, killed: false, stdout: "METRIC other_ms=1\n", stderr: "" };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.metricName, "total_ms");
    assert.deepEqual(result.parsedMetrics, { other_ms: 1 });
    assert.equal(result.issues.some((issue) => issue.code === "missing_primary_metric"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validator accepts complete research with matching primary metric", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-validator-"));
  try {
    writeResearchFiles(dir);

    const result = await validateResearch({
      workDir: dir,
      pi: {
        async exec() {
          return { code: 0, killed: false, stdout: "METRIC total_ms=1\n", stderr: "" };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.parsedMetrics, { total_ms: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
