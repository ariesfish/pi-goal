import assert from "node:assert/strict";
import test from "node:test";

import { sealedToolCallBlock } from "../../extensions/pi-goal/protocol/sealed-guards.ts";

const contract = {
  version: 1,
  objective: "cut test time",
  criteria: [],
  testGlobs: ["**/*.test.*"],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:test",
};

function state(overrides = {}) {
  return { phase: "sealed", contract, testEditsAllowed: false, benchmarkEditsAllowed: false, ...overrides };
}

test("guards only apply in the sealed phase with a contract", () => {
  assert.equal(sealedToolCallBlock(state({ phase: "probing" }), {
    toolName: "write",
    input: { path: "tests/a.test.js" },
  }), null);
  assert.equal(sealedToolCallBlock(state({ contract: null }), {
    toolName: "write",
    input: { path: "tests/a.test.js" },
  }), null);
});

test("sealed mode blocks protected test edits", () => {
  const reason = sealedToolCallBlock(state(), {
    toolName: "edit",
    input: { path: "tests/a.test.js" },
  });
  assert.match(reason, /protected/);
  assert.match(reason, /allow-tests/);

  assert.equal(sealedToolCallBlock(state({ testEditsAllowed: true }), {
    toolName: "edit",
    input: { path: "tests/a.test.js" },
  }), null);

  assert.equal(sealedToolCallBlock(state({ contract: { ...contract, allowTestEdits: true } }), {
    toolName: "edit",
    input: { path: "tests/a.test.js" },
  }), null);
});

test("sealed mode allows normal source edits", () => {
  assert.equal(sealedToolCallBlock(state(), {
    toolName: "write",
    input: { path: "src/app.ts" },
  }), null);
});

test("sealed mode blocks research state edits but allows narrative files", () => {
  assert.match(
    sealedToolCallBlock(state(), { toolName: "write", input: { path: ".goal/researches/default/goal.jsonl" } }),
    /extension-managed/,
  );
  assert.match(
    sealedToolCallBlock(state(), { toolName: "edit", input: { path: "goal.config.json" } }),
    /extension-managed/,
  );
  assert.match(
    sealedToolCallBlock(state(), { toolName: "write", input: { path: ".goal/researches/default/attempts/2.patch" } }),
    /extension-managed/,
  );
  assert.equal(
    sealedToolCallBlock(state(), { toolName: "edit", input: { path: ".goal/researches/default/goal.md" } }),
    null,
  );
});

test("sealed mode protects goal.sh and goal.checks.sh unless allowed", () => {
  for (const path of ["goal.sh", "goal.checks.sh", ".goal/researches/default/goal.sh", ".goal/researches/default/goal.checks.sh"]) {
    assert.match(
      sealedToolCallBlock(state(), { toolName: "write", input: { path } }),
      /protected in the sealed phase/,
    );
    assert.equal(
      sealedToolCallBlock(state({ benchmarkEditsAllowed: true }), { toolName: "write", input: { path } }),
      null,
    );
  }
});

test("sealed mode blocks git mutations but not read-only git", () => {
  for (const command of [
    "git reset --hard HEAD",
    "git checkout -- .",
    "git clean -fd",
    "git commit -m x",
    "git stash",
    "git revert HEAD",
  ]) {
    assert.match(
      sealedToolCallBlock(state(), { toolName: "bash", input: { command } }),
      /Git mutations/,
    );
  }

  for (const command of ["git status", "git diff", "git log -1"]) {
    assert.equal(
      sealedToolCallBlock(state(), { toolName: "bash", input: { command } }),
      null,
    );
  }
});

test("bash writes to protected paths are blocked", () => {
  const cases = [
    ["echo x > tests/a.test.js", /protected/],
    ["printf x >> tests/a.test.js", /protected/],
    ["cat <<'EOF' > tests/a.test.js\nx\nEOF", /protected/],
    ["echo x | tee goal.checks.sh", /protected in the sealed phase/],
    ["sed -i 's/a/b/' goal.sh", /protected in the sealed phase/],
    ["perl -pi -e 's/a/b/' goal.checks.sh", /protected in the sealed phase/],
    ["cp src/app.ts tests/a.test.js", /protected/],
    ["mv src/app.ts goal.sh", /protected in the sealed phase/],
    ["dd if=/dev/zero of=goal.checks.sh", /protected in the sealed phase/],
    ["truncate -s 0 .goal/researches/default/goal.jsonl", /extension-managed/],
  ];

  for (const [command, pattern] of cases) {
    assert.match(
      sealedToolCallBlock(state(), { toolName: "bash", input: { command } }),
      pattern,
      command,
    );
  }
});

test("bash writes to ordinary paths and dev sinks are allowed", () => {
  for (const command of [
    "echo x > src/app.ts",
    "echo x > /dev/null",
    "pnpm test > /tmp/out.log 2>&1",
    "git diff > patch.diff",
    "echo x > goal.md",
    "cat README.md | tee /tmp/readme.log",
  ]) {
    assert.equal(
      sealedToolCallBlock(state(), { toolName: "bash", input: { command } }),
      null,
      command,
    );
  }
});

test("bash write guards honor the allow-tests and allow-benchmark policies", () => {
  assert.equal(
    sealedToolCallBlock(state({ testEditsAllowed: true }), {
      toolName: "bash",
      input: { command: "echo x > tests/a.test.js" },
    }),
    null,
  );
  assert.equal(
    sealedToolCallBlock(state({ benchmarkEditsAllowed: true }), {
      toolName: "bash",
      input: { command: "echo x > goal.sh" },
    }),
    null,
  );
});

test("sealed protection recognises absolute paths and keeps narrative files writable", async () => {
  const { isSealedProtectedPath } = await import(
    "../../extensions/pi-goal/persistence/research-directory.ts"
  );

  // Extension-managed state, in both relative and absolute form.
  assert.equal(isSealedProtectedPath(".goal/researches/default/goal.jsonl"), true);
  assert.equal(isSealedProtectedPath("/Users/dev/project/.goal/researches/default/goal.jsonl"), true);
  assert.equal(isSealedProtectedPath("/Users/dev/project/.goal/active"), true);
  assert.equal(isSealedProtectedPath("/Users/dev/project/.goal/researches/default/attempts/2.patch"), true);

  // Narrative files and user code an agent may still write.
  assert.equal(isSealedProtectedPath(".goal/researches/default/goal.md"), false);
  assert.equal(isSealedProtectedPath("goal.ideas.md"), false);
  assert.equal(isSealedProtectedPath("goals/plan.md"), false);
});
