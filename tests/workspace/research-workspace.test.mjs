import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkResearchWorkspace, commitKeptRunResult, formatWorkspaceSafetyError } from "../../extensions/pi-goal/workspace/research-workspace.ts";

test("dirty tree check separates research state from user changes", async () => {
  const check = await checkResearchWorkspace({
    async exec() {
      return {
        code: 0,
        stdout: " M src/app.ts\n?? goal.md\n?? goal.hooks/before.sh\n",
        stderr: "",
      };
    },
  }, "/repo");

  assert.equal(check.clean, false);
  assert.deepEqual(check.userPaths, ["src/app.ts"]);
  assert.deepEqual(check.researchPaths, ["goal.md", "goal.hooks/before.sh"]);
  assert.match(formatWorkspaceSafetyError(check), /src\/app\.ts/);
});

for (const ignored of [true, false]) {
  test(`keep commits candidate changes while excluding ${ignored ? "ignored" : "unignored"} research state`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-keep-state-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Goal test");
    git("config", "user.email", "goal-test@example.invalid");
    if (ignored) fs.writeFileSync(path.join(root, ".gitignore"), ".goal/\n");
    fs.writeFileSync(path.join(root, "candidate.txt"), "baseline\n");
    git("add", ".");
    git("commit", "-q", "-m", "baseline");
    const before = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, ".goal/researches/default"), { recursive: true });
    fs.writeFileSync(path.join(root, ".goal/researches/default/goal.jsonl"), "journal evidence\n");
    fs.writeFileSync(path.join(root, "candidate.txt"), "improved\n");
    const result = await commitKeptRunResult({
      pi: { async exec(command, args, options) {
        const run = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
        return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
      } },
      workDir: root,
      description: "perf(candidate): keep the measured improvement",
      metricName: "speedup", metric: 2, status: "keep", secondaryMetrics: {},
      gateHash: "sha256:test", criteriaIds: ["M1"],
    });
    assert.ok(result.commit, result.text);
    assert.notEqual(git("rev-parse", "HEAD"), before);
    assert.equal(git("show", "HEAD:candidate.txt"), "improved");
    assert.equal(git("ls-files", ".goal"), "");
    assert.equal(fs.readFileSync(path.join(root, ".goal/researches/default/goal.jsonl"), "utf8"), "journal evidence\n");
    assert.match(git("log", "-1", "--format=%B"), /Gate: sha256:test/);
  });
}
