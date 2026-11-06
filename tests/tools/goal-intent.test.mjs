import assert from "node:assert/strict";
import test from "node:test";

import { parseGoalIntent } from "../../extensions/pi-goal/tools/goal-intent.ts";

test("an empty argument list asks for help", () => {
  assert.deepEqual(parseGoalIntent(undefined), { kind: "help" });
  assert.deepEqual(parseGoalIntent(""), { kind: "help" });
  assert.deepEqual(parseGoalIntent("   "), { kind: "help" });
});

test("command words are matched case-insensitively", () => {
  assert.deepEqual(parseGoalIntent("off"), { kind: "off" });
  assert.deepEqual(parseGoalIntent("OFF"), { kind: "off" });
  assert.deepEqual(parseGoalIntent("Clear"), { kind: "clear" });
  assert.deepEqual(parseGoalIntent("export"), { kind: "export" });
  assert.deepEqual(parseGoalIntent("ReInit"), { kind: "reinit" });
});

test("policy commands map to their own intents", () => {
  assert.deepEqual(parseGoalIntent("allow-tests"), { kind: "allow-tests" });
  assert.deepEqual(parseGoalIntent("protect-tests"), { kind: "protect-tests" });
  assert.deepEqual(parseGoalIntent("allow-benchmark"), { kind: "allow-benchmark" });
  assert.deepEqual(parseGoalIntent("protect-benchmark"), { kind: "protect-benchmark" });
});

test("select without an id asks for usage, select with an id keeps its case", () => {
  assert.deepEqual(parseGoalIntent("select"), { kind: "select-usage" });
  assert.deepEqual(parseGoalIntent("SELECT"), { kind: "select-usage" });
  assert.deepEqual(parseGoalIntent("select bundle-size"), {
    kind: "select",
    researchId: "bundle-size",
  });
  assert.deepEqual(parseGoalIntent("Select Bundle-Size"), {
    kind: "select",
    researchId: "Bundle-Size",
  });
});

test("anything else starts a research with the goal text verbatim", () => {
  const goal = "optimize unit test runtime, monitor correctness";
  assert.deepEqual(parseGoalIntent(goal), { kind: "start", goal });
  assert.deepEqual(parseGoalIntent("  padded goal  "), { kind: "start", goal: "padded goal" });
});

test("only whole command words route; a goal may start with one", () => {
  assert.deepEqual(parseGoalIntent("clearly faster parsing"), {
    kind: "start",
    goal: "clearly faster parsing",
  });
  assert.deepEqual(parseGoalIntent("exports are slow"), {
    kind: "start",
    goal: "exports are slow",
  });
});
