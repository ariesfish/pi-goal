import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";
import { createResearchPhaseState, onResearchRunFinished } from "../../extensions/pi-goal/protocol/research-phase.ts";
import { registerCheckGoalTool } from "../../extensions/pi-goal/tools/check.ts";
import { registerGoalContractTools } from "../../extensions/pi-goal/tools/contract.ts";
import { registerGoalCommand } from "../../extensions/pi-goal/tools/goal-command.ts";
import { registerInitExperimentTool, registerStartExperimentTool } from "../../extensions/pi-goal/tools/init.ts";
import { registerLogExperimentTool } from "../../extensions/pi-goal/tools/log.ts";
import { registerReviewGoalTool } from "../../extensions/pi-goal/tools/review.ts";
import { registerRunExperimentTool } from "../../extensions/pi-goal/tools/run.ts";
import { registerValidateResearchTool } from "../../extensions/pi-goal/tools/validate.ts";
import { tempProject } from "../helpers/research-fixture.mjs";

const loopOptions = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

/** Minimal stand-in for ExtensionAPI: records what a registration does. */
function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const userMessages = [];
  return {
    tools,
    commands,
    userMessages,
    registerTool(definition) {
      tools.set(definition.name, definition);
      return definition;
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
      return definition;
    },
    on() {},
    registerShortcut() {},
    sendUserMessage(message) {
      userMessages.push(message);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

/** Minimal stand-in for ExtensionContext. */
function fakeCtx(cwd, options = {}) {
  const notices = [];
  return {
    notices,
    cwd,
    hasUI: options.hasUI ?? false,
    isIdle: () => options.idle ?? true,
    abort() {},
    ui: {
      notify(message, level) {
        notices.push({ message, level });
      },
      async confirm() {
        return true;
      },
      setWidget() {},
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getBranch: () => [],
    },
  };
}

/** The host port a registration needs, with the view announcement recorded. */
function fakePort(runtime = createSessionRuntime()) {
  const changes = [];
  const port = {
    changes,
    getRuntime: () => runtime,
    researchChanged(_ctx, workDir) {
      changes.push(workDir);
    },
    exec: {
      async exec() {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async fireHook() {
      return null;
    },
  };
  return port;
}

function run(tool, params, ctx) {
  return tool.execute("call-1", params, undefined, () => {}, ctx);
}

function resultText(result) {
  return result.content[0].text;
}

function registerAll(pi, port) {
  registerValidateResearchTool(pi);
  registerInitExperimentTool(pi, port);
  registerStartExperimentTool(pi, port);
  registerGoalContractTools(pi, port);
  registerCheckGoalTool(pi, port);
  registerReviewGoalTool(pi, port);
  registerRunExperimentTool(pi, port);
  registerLogExperimentTool(pi, port);
  registerGoalCommand(pi, {
    ...port,
    clearSessionUi() {},
    reconstructState() {},
    stopDashboardServer() {},
    async exportDashboard() {},
    loopOptions,
  });
}

const TOOL_NAMES = [
  "check_goal",
  "frame_goal",
  "freeze_criteria",
  "init_goal",
  "log_goal",
  "probe_goal",
  "review_goal",
  "run_goal",
  "start_goal",
  "validate_goal",
];

test("every tool and the /goal command register their public name", () => {
  const pi = fakePi();
  registerAll(pi, fakePort());

  assert.deepEqual(
    [...pi.tools.keys()].sort(),
    TOOL_NAMES,
  );
  assert.deepEqual([...pi.commands.keys()], ["goal"]);
});

test("the extension composition root registers the whole surface", async () => {
  const { default: goalExtension } = await import("../../extensions/pi-goal/index.ts");
  const pi = fakePi();

  goalExtension(pi);

  assert.deepEqual([...pi.tools.keys()].sort(), TOOL_NAMES);
  assert.deepEqual([...pi.commands.keys()], ["goal"]);
});

test("validate_goal reports a broken workingDir before touching the workspace", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    fs.writeFileSync(
      path.join(projectDir, "goal.config.json"),
      JSON.stringify({ workingDir: "missing-dir" }),
    );
    const pi = fakePi();
    registerAll(pi, fakePort());

    const result = await run(pi.tools.get("validate_goal"), {}, fakeCtx(projectDir));

    assert.match(resultText(result), /workingDir .* does not exist/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("check_goal refuses to run without a frozen contract", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const pi = fakePi();
    const port = fakePort();
    registerAll(pi, port);

    const result = await run(pi.tools.get("check_goal"), {}, fakeCtx(projectDir));

    assert.match(resultText(result), /No frozen contract/);
    assert.deepEqual(port.changes, []);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("review_goal explains how to configure a reviewer", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    runtime.state.contract = {
      version: 1,
      objective: "cut test time",
      criteria: [],
      testGlobs: [],
      scopeGlobs: [],
      allowTestEdits: false,
      frozenAt: 1,
      hash: "sha256:test",
    };
    const pi = fakePi();
    const port = fakePort(runtime);
    registerAll(pi, port);

    const result = await run(pi.tools.get("review_goal"), {}, fakeCtx(projectDir));

    assert.match(resultText(result), /No reviewer configured/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("frame_goal is refused outside the framing phase", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    runtime.loop.phase = "sealed";
    const pi = fakePi();
    registerAll(pi, fakePort(runtime));

    const result = await run(pi.tools.get("frame_goal"), {
      directions: [
        {
          id: "D1",
          title: "t",
          mechanism: "m",
          proxyMetric: "p",
          cost: "c",
          risk: "r",
          killIf: "k",
        },
      ],
    }, fakeCtx(projectDir));

    assert.match(resultText(result), /frame_goal runs while framing/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run_goal blocks at the experiment run limit", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    runtime.state.runLimit = 1;
    runtime.state.results.push({
      commit: "abc1234",
      metric: 100,
      metrics: {},
      status: "keep",
      description: "baseline",
      timestamp: 1,
      experimentIndex: 0,
      confidence: null,
    });
    const pi = fakePi();
    const port = fakePort(runtime);
    registerAll(pi, port);

    const result = await run(pi.tools.get("run_goal"), { command: "bash goal.sh" }, fakeCtx(projectDir));

    assert.match(resultText(result), /Maximum runs reached/);
    assert.deepEqual(port.changes, []);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run_goal is blocked while a previous run awaits its log", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    onResearchRunFinished(runtime.loop, {
      command: "bash goal.sh",
      passed: true,
      crashed: false,
      timedOut: false,
      checksPass: null,
      checksTimedOut: false,
      parsedPrimary: 90,
      parsedMetrics: { total_ms: 90 },
      metricName: "total_ms",
      metricUnit: "ms",
    });
    const pi = fakePi();
    registerAll(pi, fakePort(runtime));

    const result = await run(pi.tools.get("run_goal"), { command: "bash goal.sh" }, fakeCtx(projectDir));

    assert.match(resultText(result), /Previous run_goal has not been logged/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("log_goal records the run and announces one research change", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    runtime.state.name = "Speed";
    runtime.state.metricName = "total_ms";
    runtime.state.metricUnit = "ms";
    runtime.loop = createResearchPhaseState();
    const pi = fakePi();
    const port = fakePort(runtime);
    registerAll(pi, port);

    const result = await run(pi.tools.get("log_goal"), {
      commit: "pending",
      metric: 100,
      status: "discard",
      description: "slower attempt",
      asi: { hypothesis: "fewer allocations" },
    }, fakeCtx(projectDir));

    assert.match(resultText(result), /discard/i);
    assert.equal(result.details.runResult.status, "discard");
    assert.equal(result.details.state.results.length, 1);
    assert.deepEqual(port.changes, [projectDir]);
    assert.equal(fs.existsSync(path.join(projectDir, ".goal", "researches", "default", "goal.jsonl")), true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("/goal off deactivates the research and says so", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    runtime.loop.mode = true;
    runtime.loop.phase = "sealed";
    const pi = fakePi();
    registerAll(pi, fakePort(runtime));
    const ctx = fakeCtx(projectDir);

    await pi.commands.get("goal").handler("off", ctx);

    assert.equal(runtime.loop.mode, false);
    assert.equal(runtime.loop.phase, "inactive");
    assert.match(ctx.notices.at(-1).message, /Research mode OFF/);
    assert.deepEqual(pi.userMessages, []);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("/goal with goal text starts the framing protocol", async () => {
  const projectDir = tempProject("pi-goal-tool");
  try {
    const runtime = createSessionRuntime();
    const pi = fakePi();
    registerAll(pi, fakePort(runtime));
    const ctx = fakeCtx(projectDir);

    await pi.commands.get("goal").handler("optimize unit test runtime", ctx);

    assert.equal(runtime.loop.mode, true);
    assert.equal(runtime.loop.phase, "framing");
    assert.equal(pi.userMessages.length, 1);
    assert.match(pi.userMessages[0], /RESEARCH_FRAMING_REQUIRED/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
