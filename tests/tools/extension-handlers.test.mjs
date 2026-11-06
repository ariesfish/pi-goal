import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import goalExtension from "../../extensions/pi-goal/index.ts";
import {
  appendConfigEntry,
  appendRunEntry,
  journalPath,
  tempProject,
} from "../helpers/research-fixture.mjs";
import { selectActiveResearch } from "../../extensions/pi-goal/persistence/research-directory.ts";
import { fakeCtx, fakePi } from "../helpers/fake-host.mjs";

const CONTRACT = {
  version: 1,
  objective: "cut test time",
  criteria: [
    {
      id: "C1",
      statement: "suite faster",
      kind: "metric",
      blocking: true,
      metric: { name: "total_ms", direction: "lower" },
    },
  ],
  testGlobs: ["**/*.test.js"],
  scopeGlobs: [],
  allowTestEdits: false,
  frozenAt: 1,
  hash: "sha256:contract",
};

/** A project with a sealed research: contract, config, one kept run. */
function sealedProject(prefix) {
  const projectDir = tempProject(prefix);
  selectActiveResearch(projectDir, "default");
  fs.mkdirSync(path.dirname(journalPath(projectDir)), { recursive: true });
  fs.appendFileSync(
    journalPath(projectDir),
    [
      JSON.stringify({ type: "contract", contract: CONTRACT }),
      JSON.stringify({
        type: "config",
        name: "Speed",
        metricName: "total_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "aaa1111",
        metric: 100,
        metrics: {},
        status: "keep",
        description: "baseline",
        timestamp: 1,
        experimentIndex: 0,
        confidence: null,
      }),
    ].join("\n") + "\n",
  );
  return projectDir;
}

function boot(projectDir) {
  const pi = fakePi();
  goalExtension(pi);
  return { pi, ctx: fakeCtx(projectDir) };
}

function systemPromptFor(pi, ctx, extra = "") {
  return pi.emit(
    "before_agent_start",
    { systemPrompt: extra, entries: [], prompt: "hi" },
    ctx,
  );
}

test("session_start rebuilds the research from the journal", async () => {
  const projectDir = sealedProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);

    await pi.emit("session_start", { type: "session_start" }, ctx);
    const injection = await systemPromptFor(pi, ctx, "base");

    assert.match(injection.systemPrompt, /^base/);
    assert.match(injection.systemPrompt, /Phase: sealed/);

    // A tree switch rebuilds from the same journal path.
    await pi.emit("session_tree", { type: "session_tree" }, ctx);
    assert.match((await systemPromptFor(pi, ctx, "base")).systemPrompt, /Phase: sealed/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("before_agent_start injects nothing without an active research", async () => {
  const projectDir = tempProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);

    await pi.emit("session_start", { type: "session_start" }, ctx);
    const injection = await systemPromptFor(pi, ctx, "base");

    assert.equal(injection, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("tool_call blocks protected writes in the sealed phase", async () => {
  const projectDir = sealedProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    await pi.emit("session_start", { type: "session_start" }, ctx);

    const blocked = await pi.emit(
      "tool_call",
      { toolName: "edit", input: { path: "tests/suite.test.js" } },
      ctx,
    );
    const allowed = await pi.emit(
      "tool_call",
      { toolName: "edit", input: { path: "src/app.ts" } },
      ctx,
    );

    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /protected/);
    assert.equal(allowed, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("agent_before_settle continues once a run was logged in the sealed phase", async () => {
  const projectDir = sealedProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    await pi.emit("session_start", { type: "session_start" }, ctx);
    await pi.emit("agent_start", { type: "agent_start" }, ctx);

    // A logged run is what makes the sealed loop want another turn.
    const logged = await pi.tools.get("log_goal").execute(
      "call-1",
      {
        commit: "pending",
        metric: 110,
        status: "discard",
        description: "slower",
        asi: { hypothesis: "more allocation" },
      },
      undefined,
      () => {},
      ctx,
    );
    assert.equal(logged.details.runResult.status, "discard");

    const decision = await pi.emit(
      "agent_before_settle",
      { context: { canContinue: true }, outcome: "completed", entries: [] },
      ctx,
    );

    assert.equal(decision.continue, true);
    assert.equal(decision.entries.at(-1).customType, "goal-next-action");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("agent_before_settle stays out of the way when no research is active", async () => {
  const projectDir = tempProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    await pi.emit("session_start", { type: "session_start" }, ctx);

    const decision = await pi.emit(
      "agent_before_settle",
      { context: { canContinue: true }, outcome: "completed", entries: [] },
      ctx,
    );

    assert.equal(decision, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session_before_compact only takes over while research is active", async () => {
  const projectDir = sealedProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    const event = {
      preparation: { firstKeptEntryId: "entry-7", tokensBefore: 1234 },
    };

    await pi.emit("session_start", { type: "session_start" }, ctx);
    const takeover = await pi.emit("session_before_compact", event, ctx);

    assert.equal(takeover.compaction.firstKeptEntryId, "entry-7");
    assert.equal(takeover.compaction.tokensBefore, 1234);
    assert.match(takeover.compaction.summary, /## Phase\n\nsealed/);
    assert.match(takeover.compaction.summary, /Goal: Speed/);
    assert.match(takeover.compaction.summary, /#1 keep\s+100/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session_before_compact leaves the default summary alone when research is off", async () => {
  const projectDir = tempProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    await pi.emit("session_start", { type: "session_start" }, ctx);

    const decision = await pi.emit(
      "session_before_compact",
      { preparation: { firstKeptEntryId: "entry-7", tokensBefore: 10 } },
      ctx,
    );

    assert.equal(decision, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session_shutdown clears the session runtime", async () => {
  const projectDir = sealedProject("pi-goal-handler");
  try {
    const { pi, ctx } = boot(projectDir);
    await pi.emit("session_start", { type: "session_start" }, ctx);
    assert.match((await systemPromptFor(pi, ctx, "base")).systemPrompt, /Phase: sealed/);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    const injection = await systemPromptFor(pi, ctx, "base");

    assert.equal(injection, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a journal with only a config header hydrates the legacy metric contract", async () => {
  const projectDir = tempProject("pi-goal-handler");
  try {
    selectActiveResearch(projectDir, "default");
    appendConfigEntry(projectDir);
    appendRunEntry(projectDir);
    const { pi, ctx } = boot(projectDir);

    await pi.emit("session_start", { type: "session_start" }, ctx);
    const injection = await systemPromptFor(pi, ctx, "base");

    assert.match(injection.systemPrompt, /Phase: sealed/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
