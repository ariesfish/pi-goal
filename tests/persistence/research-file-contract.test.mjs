import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import {
  readResearchFileContract,
  shouldUseScriptCommandOnly,
} from "../../extensions/pi-goal/persistence/research-files.ts";
import {
  activationSnapshotFor,
  promptSnapshotFor,
} from "../../extensions/pi-goal/protocol/research-file-snapshots.ts";
import { ensureActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";

test("research file contract summarizes active research files and config header", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-contract-"));
  try {
    const researchDir = ensureActiveResearch(projectDir).paths.directory;
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
    assert.equal(contract.hasContract, false);
    assert.equal(contract.hasRuns, false);
    assert.equal(contract.metricName, "total_ms");
    assert.equal(shouldUseScriptCommandOnly(contract), true);
    assert.deepEqual(activationSnapshotFor(contract, "optimize"), {
      userGoal: "optimize",
      hasRules: true,
      hasConfig: true,
      hasBenchmarkScript: true,
      hasContract: false,
    });
    assert.equal(promptSnapshotFor(contract).mdPath.endsWith("goal.md"), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("research file contract reports invalid benchmark script", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-contract-"));
  try {
    const researchDir = ensureActiveResearch(projectDir).paths.directory;
    fs.mkdirSync(path.join(researchDir, "goal.sh"));

    const contract = readResearchFileContract(projectDir);

    assert.equal(contract.hasBenchmarkScript, true);
    assert.match(contract.invalidBenchmarkScript ?? "", /not a file/);
    assert.equal(shouldUseScriptCommandOnly(contract), false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("the default research falls back to legacy project-root files", () => {
  const projectDir = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-contract-"));
  try {
    fs.writeFileSync(path.join(projectDir, "goal.md"), "# Root goal\n");
    fs.writeFileSync(path.join(projectDir, "goal.sh"), "#!/usr/bin/env bash\n");

    const contract = readResearchFileContract(projectDir);

    assert.equal(contract.hasRules, true);
    assert.equal(contract.hasBenchmarkScript, true);
    assert.equal(contract.rulesPath, path.join(projectDir, "goal.md"));
    assert.equal(contract.scriptPath, path.join(projectDir, "goal.sh"));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("research state detection is limited to .goal and root goal files", async () => {
  const { isResearchStatePath } = await import("../../extensions/pi-goal/persistence/research-directory.ts");

  assert.equal(isResearchStatePath("src/goal.ts"), false);
  assert.equal(isResearchStatePath("src/goal.test.ts"), false);
  assert.equal(isResearchStatePath("goal.md"), true);
  assert.equal(isResearchStatePath(".goal/researches/default/goal.jsonl"), true);
  assert.equal(isResearchStatePath("nested/.goal/x"), false);
});
