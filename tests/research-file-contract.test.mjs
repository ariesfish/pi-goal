import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { readResearchFileContract } from "../extensions/pi-goal/persistence/research-files.ts";
import {
  activationSnapshotFor,
  promptSnapshotFor,
} from "../extensions/pi-goal/protocol/research-file-snapshots.ts";
import { shouldUseScriptCommandOnly } from "../extensions/pi-goal/execution/research-command-policy.ts";
import { ensureActiveResearchDirectory } from "../extensions/pi-goal/persistence/research-directory.ts";

test("research file contract summarizes active research files and config header", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-contract-"));
  try {
    const researchDir = ensureActiveResearchDirectory(projectDir);
    fs.writeFileSync(path.join(researchDir, "goal.md"), "# Goal\n");
    fs.writeFileSync(path.join(researchDir, "goal.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(path.join(researchDir, "goal.ideas.md"), "- try x\n");
    fs.writeFileSync(path.join(researchDir, "goal.checks.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(path.join(researchDir, "goal.jsonl"), '{"type":"config","name":"Speed","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}\n');

    const contract = readResearchFileContract(projectDir);

    assert.equal(contract.hasRules, true);
    assert.equal(contract.hasBenchmarkScript, true);
    assert.equal(contract.hasChecks, true);
    assert.equal(contract.hasIdeas, true);
    assert.equal(contract.hasJournal, true);
    assert.equal(contract.hasConfigHeader, true);
    assert.equal(contract.metricName, "total_ms");
    assert.equal(shouldUseScriptCommandOnly(contract), true);
    assert.deepEqual(activationSnapshotFor(contract, "optimize"), {
      userGoal: "optimize",
      hasRules: true,
      hasConfig: true,
      hasBenchmarkScript: true,
    });
    assert.equal(promptSnapshotFor(contract).mdPath.endsWith("goal.md"), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("research file contract reports invalid benchmark script", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-contract-"));
  try {
    const researchDir = ensureActiveResearchDirectory(projectDir);
    fs.mkdirSync(path.join(researchDir, "goal.sh"));

    const contract = readResearchFileContract(projectDir);

    assert.equal(contract.hasBenchmarkScript, true);
    assert.match(contract.invalidBenchmarkScript ?? "", /not a file/);
    assert.equal(shouldUseScriptCommandOnly(contract), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
