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
  return { phase: "sealed", contract, testEditsAllowed: false, ...overrides };
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

test("sealed mode blocks research state edits", () => {
  assert.match(
    sealedToolCallBlock(state(), { toolName: "write", input: { path: ".goal/researches/default/goal.jsonl" } }),
    /extension-managed/,
  );
  assert.match(
    sealedToolCallBlock(state(), { toolName: "edit", input: { path: "goal.config.json" } }),
    /extension-managed/,
  );
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
