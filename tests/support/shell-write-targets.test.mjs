import assert from "node:assert/strict";
import test from "node:test";

import { bashWriteTargets } from "../../extensions/pi-goal/support/shell-write-targets.ts";

test("extracts redirection and tee targets", () => {
  assert.deepEqual(bashWriteTargets("echo x > tests/a.test.js"), ["tests/a.test.js"]);
  assert.deepEqual(bashWriteTargets("printf x >> goal.sh"), ["goal.sh"]);
  assert.deepEqual(bashWriteTargets("echo x | tee -a goal.checks.sh"), ["goal.checks.sh"]);
  assert.deepEqual(bashWriteTargets("echo x > /dev/null 2>&1"), []);
  assert.deepEqual(bashWriteTargets("pnpm test > /tmp/out.log 2>&1"), ["/tmp/out.log"]);
});

test("extracts in-place edit and copy targets", () => {
  assert.deepEqual(bashWriteTargets("sed -i 's/a/b/' goal.sh"), ["goal.sh"]);
  assert.deepEqual(bashWriteTargets("perl -pi -e 's/a/b/' goal.checks.sh"), ["goal.checks.sh"]);
  assert.deepEqual(bashWriteTargets("cp src/app.ts tests/a.test.js"), ["tests/a.test.js"]);
  assert.deepEqual(bashWriteTargets("mv src/app.ts goal.sh"), ["goal.sh"]);
});

test("extracts dd and truncate targets", () => {
  assert.deepEqual(bashWriteTargets("dd if=/dev/zero of=goal.checks.sh"), ["goal.checks.sh"]);
  assert.deepEqual(bashWriteTargets("truncate -s 0 .goal/researches/default/goal.jsonl"), [".goal/researches/default/goal.jsonl"]);
});

test("read-only commands yield no targets", () => {
  assert.deepEqual(bashWriteTargets("git status"), []);
  assert.deepEqual(bashWriteTargets("git diff > patch.diff"), ["patch.diff"]);
  assert.deepEqual(bashWriteTargets("cat README.md"), []);
  // Residual bypass: arbitrary interpreters are not parsed.
  assert.deepEqual(bashWriteTargets("python -c \"open('goal.sh','w').write('x')\""), []);
});
