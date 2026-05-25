/**
 * goal — Pi Extension
 *
 * Generic autonomous research loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_goal` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_goal` tool — records run results with research-persisted state
 * - Status widget showing run count + best metric
 * - Configurable shortcuts to expand/collapse and fullscreen the dashboard
 * - Adds research guidance to the system prompt and points the agent at goal.md
 * - Injects goal.md into context on every turn via before_agent_start
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type ResearchSnapshot,
} from "./hooks.ts";
import {
  parseJournalEntry,
  isRunResultEntry,
  reconstructResearchStateFromJournal,
} from "./research-journal.ts";
import {
  cloneResearchState,
  createResearchState,
  computeConfidence,
  findBaselineMetric,
  findBestMetric,
  type ResearchState,
} from "./research-state.ts";
import {
  activateLoop,
  clearLoop,
  composeCompactionResumeMessage as composeControllerCompactionResumeMessage,
  composeResumeMessage as composeControllerResumeMessage,
  deactivateLoop,
  detectPhaseFromFiles,
  enterLoopingFromPersistedLog,
  resetLoopForAgentStart,
  shouldAutoResumeAfterCompact as controllerShouldAutoResumeAfterCompact,
  shouldAutoResumeAfterTurn as controllerShouldAutoResumeAfterTurn,
  systemPromptFor as controllerSystemPromptFor,
  type LoopControllerOptions,
} from "./loop-controller.ts";
import {
  researchSummaryPathsFor,
  buildResearchCompactionSummary,
} from "./compaction.ts";
import { resolveGoalShortcuts } from "./shortcuts.ts";
import { readRunLimit, resolveWorkDir, validateWorkDir } from "./config.ts";
import { activeResearchPath, ensureActiveResearchDirectory, sanitizeResearchId } from "./research-directory.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "./experiment-workspace.ts";
import {
  researchChecksPath,
  researchIdeasPath,
  researchJournalPath,
  researchRulesPath,
  researchScriptPath,
} from "./paths.ts";
import {
  createRuntimeStore,
  type SessionRuntime,
  type LogDetails,
} from "./runtime.ts";
import { createDashboardServer } from "./dashboard-server.ts";
import { createDashboardOverlayController } from "./dashboard-overlay.ts";
import { createWidgetController } from "./widget.ts";
import { createResumeAdapter } from "./resume-adapter.ts";
import { registerValidateResearchTool } from "./tools/validate.ts";
import { registerInitExperimentTool, registerStartExperimentTool } from "./tools/init.ts";
import { registerRunExperimentTool } from "./tools/run.ts";
import { registerLogExperimentTool } from "./tools/log.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function goalExtension(pi: ExtensionAPI) {
  const MAX_AUTORESUME_TURNS = 20;
  const MAX_ACTIVATION_TURNS = 3;
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";
  const loopOptions: LoopControllerOptions = {
    maxAutoResumeTurns: MAX_AUTORESUME_TURNS,
    maxActivationTurns: MAX_ACTIVATION_TURNS,
    benchmarkGuardrail: BENCHMARK_GUARDRAIL,
  };

  // Outlasts pi's internal retry (setTimeout 0) and compaction-continue
  // (setTimeout 100); see badlogic/pi-mono#2023, #2110.
  const SETTLED_WINDOW_MS = 800;
  const shortcuts = resolveGoalShortcuts();

  const dashboardHintVariants = (toggleAction: "expand" | "collapse"): string[] => {
    const toggle = shortcuts.toggleDashboard
      ? `${shortcuts.toggleDashboard} ${toggleAction}`
      : null;
    const fullscreen = shortcuts.fullscreenDashboard
      ? `${shortcuts.fullscreenDashboard} fullscreen`
      : null;

    if (toggle && fullscreen) {
      return [
        `${toggle} • ${fullscreen}`,
        `${toggle} • full: ${shortcuts.fullscreenDashboard}`,
        `${shortcuts.toggleDashboard} • ${shortcuts.fullscreenDashboard}`,
      ];
    }

    return [toggle, fullscreen].filter((hint): hint is string => hint !== null);
  };

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): SessionRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  const shouldAutoResumeAfterTurn = (runtime: SessionRuntime): boolean =>
    controllerShouldAutoResumeAfterTurn(runtime.loop, loopOptions);

  const shouldAutoResumeAfterCompact = (runtime: SessionRuntime): boolean =>
    controllerShouldAutoResumeAfterCompact(runtime.loop);

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext): void => {
    ctx.ui.notify(
      `Research auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
      "info",
    );
  };

  const composeResumeMessage = (_ctx: ExtensionContext): string =>
    composeControllerResumeMessage(getRuntime(_ctx).loop, loopOptions);

  const composeCompactionResumeMessage = (_ctx: ExtensionContext): string =>
    composeControllerCompactionResumeMessage(loopOptions);

  const resume = createResumeAdapter({
    pi,
    loopOptions,
    settledWindowMs: SETTLED_WINDOW_MS,
    notifyAutoResumeLimitReached,
    composeResumeMessage,
  });

  const hasResearchRules = (ctx: ExtensionContext): boolean =>
    fs.existsSync(researchRulesPath(resolveWorkDir(ctx.cwd)));

  const readJsonlLines = (workDir: string): string[] => {
    const jsonlPath = researchJournalPath(workDir);
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  };

  const readLastRun = (workDir: string): Record<string, unknown> | null => {
    const lines = readJsonlLines(workDir);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseJournalEntry(lines[i]);
      if (isRunResultEntry(entry)) return entry;
    }
    return null;
  };

  const buildResearchSnapshot = (state: ResearchState): ResearchSnapshot => ({
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentExperimentIndex, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  });

  const fireHook = async (payload: HookPayload): Promise<string | null> => {
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(researchJournalPath(payload.cwd), payload.event, result);
    return steerMessageFor(payload.event, result);
  };

  const dashboardOverlay = createDashboardOverlayController();
  const widget = createWidgetController({ dashboardHintVariants });
  const dashboardServer = createDashboardServer();
  const broadcastDashboardUpdate = (workDir: string): void => dashboardServer.broadcast(workDir);
  const stopDashboardServer = (): void => dashboardServer.stop();

  const clearSessionUi = (ctx: ExtensionContext) => {
    dashboardOverlay.clear();
    widget.clear(ctx);
  };

  const researchHelp = () =>
    [
      "Usage: /goal [off|clear|export|reinit|select <research-id>|<text>]",
      "",
      "<text> enters goal mode and starts or resumes the loop.",
      "reinit starts a new experiment in the active research with a fresh baseline.",
      "select <research-id> switches the active research directory.",
      "off leaves goal mode.",
      "clear deletes goal.jsonl and turns goal mode off.",
      "export opens a local live dashboard for goal.jsonl in your browser.",

      "",
      "Examples:",
      "  /goal optimize unit test runtime, monitor correctness",
      "  /goal model training, run 5 minutes of train.py and note the loss ratio as optimization target",
      "  /goal reinit",
      "  /goal select bundle-size",
      "  /goal export",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    resume.cancel(runtime);
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.activeRun = null;
    resetLoopForAgentStart(runtime.loop);
    runtime.loop.autoResumeTurns = 0;
    runtime.loop.activationTurns = 0;
    runtime.state = createResearchState();

    let state = runtime.state;

    // Resolve effective working directory (config stays in ctx.cwd, files in workDir)
    const workDir = resolveWorkDir(ctx.cwd);

    // Primary: read from goal.jsonl (alongside goal.md/sh)
    const jsonlPath = researchJournalPath(workDir);
    let loadedFromJsonl = false;
    try {
      if (fs.existsSync(jsonlPath)) {
        const reconstructed = reconstructResearchStateFromJournal(fs.readFileSync(jsonlPath, "utf-8"));
        state.name = reconstructed.name;
        state.metricName = reconstructed.metricName;
        state.metricUnit = reconstructed.metricUnit;
        state.bestDirection = reconstructed.bestDirection;
        state.currentExperimentIndex = reconstructed.currentExperimentIndex;
        state.results = reconstructed.results.map((result) => ({
          ...result,
          metrics: { ...result.metrics },
        }));
        state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

        if (state.results.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(state.results, state.currentExperimentIndex);
          state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from pi session history when no research journal has been logged yet.
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_goal")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneResearchState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
          }
        }
      }
    }


    // Read max experiments from config file
    state.runLimit = readRunLimit(ctx.cwd);

    // Auto-enter goal mode when a persisted experiment log exists.
    // If a skill created goal.md + goal.sh but did not initialize,
    // enter needs_init so the extension can push the agent across the seam.
    if (fs.existsSync(researchJournalPath(workDir))) {
      enterLoopingFromPersistedLog(runtime.loop);
    } else {
      const phase = detectPhaseFromFiles({
        hasRules: fs.existsSync(researchRulesPath(workDir)),
        hasConfig: false,
        hasBenchmarkScript: fs.existsSync(researchScriptPath(workDir)),
      });
      if (phase === "needs_init") {
        runtime.loop.mode = true;
        runtime.loop.phase = "needs_init";
      } else {
        deactivateLoop(runtime.loop);
      }
    }

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => widget.update(ctx, getRuntime(ctx));

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    dashboardOverlay.clear();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    resume.cancel(getRuntime(ctx));
    runtimeStore.clear(getSessionKey(ctx));
    stopDashboardServer();
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    resetLoopForAgentStart(runtime.loop);
    resume.pause(runtime);
  });


  pi.on("session_before_compact", async (event, ctx) => {
    resume.pause(getRuntime(ctx));
    return goalCompactionFor(ctx, event);
  });

  pi.on("session_compact", async (_event, ctx) => {
    resume.ensure(ctx, getRuntime(ctx), shouldAutoResumeAfterCompact, composeCompactionResumeMessage);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.activeRun = null;
    dashboardOverlay.requestRender();
    resume.ensure(ctx, runtime, shouldAutoResumeAfterTurn);
  });

  // When in goal mode, add phase-specific loop control to the system prompt.
  // Only paths and required actions — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    const workDir = resolveWorkDir(ctx.cwd);
    const mdPath = researchRulesPath(workDir);
    const ideasPath = researchIdeasPath(workDir);
    const checksPath = researchChecksPath(workDir);
    const jsonlPath = researchJournalPath(workDir);
    const hasRules = fs.existsSync(mdPath);
    const hasBenchmarkScript = fs.existsSync(researchScriptPath(workDir));
    const hasConfig = fs.existsSync(jsonlPath);

    if (!runtime.loop.mode && hasRules && hasBenchmarkScript && !hasConfig) {
      runtime.loop.mode = true;
      runtime.loop.phase = "needs_init";
    }

    const extra = controllerSystemPromptFor(runtime.loop, {
      hasRules,
      hasConfig,
      hasBenchmarkScript,
      hasIdeas: fs.existsSync(ideasPath),
      hasChecks: fs.existsSync(checksPath),
      mdPath,
      ideasPath,
      checksPath,
    }, loopOptions);

    if (!extra) return;
    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // validate_goal tool
  // -----------------------------------------------------------------------

  registerValidateResearchTool(pi);

  // -----------------------------------------------------------------------
  // Experiment configuration tools
  // -----------------------------------------------------------------------

  const experimentConfigToolDeps = {
    getRuntime,
    updateWidget,
    broadcastDashboardUpdate,
    fireHook,
    readLastRun,
    buildResearchSnapshot,
  };
  registerInitExperimentTool(pi, experimentConfigToolDeps);
  registerStartExperimentTool(pi, experimentConfigToolDeps);

  // -----------------------------------------------------------------------
  // run_goal tool
  // -----------------------------------------------------------------------

  registerRunExperimentTool(pi, {
    getRuntime,
    updateWidget,
    requestOverlayRender: () => dashboardOverlay.requestRender(),
  });

  // -----------------------------------------------------------------------
  // log_goal tool
  // -----------------------------------------------------------------------

  registerLogExperimentTool(pi, {
    getRuntime,
    updateWidget,
    requestOverlayRender: () => dashboardOverlay.requestRender(),
    broadcastDashboardUpdate,
    fireHook,
    buildResearchSnapshot,
  });

  // -----------------------------------------------------------------------
  // Toggle dashboard expand/collapse shortcut
  // -----------------------------------------------------------------------

  if (shortcuts.toggleDashboard) {
    pi.registerShortcut(shortcuts.toggleDashboard, {
      description: "Toggle goal dashboard",
      handler: async (ctx) => {
        const runtime = getRuntime(ctx);
        const state = runtime.state;
        if (state.results.length === 0) {
          if (!runtime.loop.mode && !fs.existsSync(researchRulesPath(resolveWorkDir(ctx.cwd)))) {
            ctx.ui.notify("No runs yet — run /goal to get started", "info");
          } else {
            ctx.ui.notify("No runs yet", "info");
          }
          return;
        }
        runtime.dashboardExpanded = !runtime.dashboardExpanded;
        updateWidget(ctx);
      },
    });
  }

  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay shortcut
  // -----------------------------------------------------------------------

  if (shortcuts.fullscreenDashboard) {
    pi.registerShortcut(shortcuts.fullscreenDashboard, {
      description: "Fullscreen goal dashboard",
      handler: async (ctx) => {
        const runtime = getRuntime(ctx);
        const state = runtime.state;
        if (state.results.length === 0) {
          ctx.ui.notify("No runs yet", "info");
          return;
        }

        await dashboardOverlay.open(ctx, runtime);
      },
    });
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // /goal command — enter goal mode
  // -----------------------------------------------------------------------

  pi.registerCommand("goal", {
    description: "Start, stop, clear, or resume goal mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(researchHelp(), "info");
        return;
      }

      if (command === "off") {
        const wasRunning = !ctx.isIdle();

        deactivateLoop(runtime.loop);
        runtime.dashboardExpanded = false;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.activeRun = null;
        resume.cancel(runtime);
        stopDashboardServer();
        clearSessionUi(ctx);
        if (wasRunning) ctx.abort();
        ctx.ui.notify(
          wasRunning ? "Research mode OFF — aborting current run" : "Research mode OFF",
          "info"
        );
        return;
      }

      if (command === "export") {
        await dashboardServer.export(ctx, resolveWorkDir(ctx.cwd));
        return;
      }

      if (command === "select") {
        ctx.ui.notify("Usage: /goal select <research-id>", "info");
        return;
      }

      if (command.startsWith("select ")) {
        const workDirError = validateWorkDir(ctx.cwd);
        if (workDirError) {
          ctx.ui.notify(workDirError, "error");
          return;
        }
        const researchId = trimmedArgs.slice("select".length).trim();
        if (!researchId) {
          ctx.ui.notify("Usage: /goal select <research-id>", "info");
          return;
        }
        const workDir = resolveWorkDir(ctx.cwd);
        fs.mkdirSync(path.dirname(activeResearchPath(workDir)), { recursive: true });
        fs.writeFileSync(activeResearchPath(workDir), sanitizeResearchId(researchId) + "\n");
        ensureActiveResearchDirectory(workDir);
        reconstructState(ctx);
        ctx.ui.notify(`Active research selected: ${sanitizeResearchId(researchId)}`, "info");
        return;
      }

      if (command === "reinit") {
        if (runtime.state.results.length === 0) {
          ctx.ui.notify("No runs yet — use init_goal to initialize the active research first", "info");
          return;
        }
        resume.sendWhenReady(ctx, [
          "Start a new Experiment in the active Research now.",
          "Call start_goal with the updated metric, unit, and direction, then run the new baseline with run_goal and log_goal.",
          "Use this only if the Research target is unchanged but the primary metric, direction, workload, measurement method, or baseline comparability changed.",
        ].join("\n"));
        return;
      }

      if (command === "clear") {
        const jsonlPath = researchJournalPath(resolveWorkDir(ctx.cwd));
        clearLoop(runtime.loop);
        runtime.dashboardExpanded = false;
        runtime.lastRunChecks = null;
        runtime.activeRun = null;
        resume.cancel(runtime);
        runtime.state = createResearchState();
        stopDashboardServer();
        updateWidget(ctx);

        if (fs.existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
            ctx.ui.notify("Deleted goal.jsonl and turned goal mode OFF", "info");
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete goal.jsonl: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
          }
        } else {
          ctx.ui.notify("No goal.jsonl found. Research mode OFF", "info");
        }
        return;
      }

      if (runtime.loop.mode) {
        ctx.ui.notify("Research already active — use '/goal off' to stop first", "info");
        return;
      }

      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        ctx.ui.notify(workDirError, "error");
        return;
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const dirtyCheck = await checkResearchWorkspace(pi, workDir);
      const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
      if (dirtyBlock) {
        ctx.ui.notify(dirtyBlock, "error");
        return;
      }
      const jsonlPath = researchJournalPath(workDir);
      const rulesLoaded = hasResearchRules(ctx);
      const hasBenchmarkScript = fs.existsSync(researchScriptPath(workDir));
      const kickoff = activateLoop(runtime.loop, {
        userGoal: trimmedArgs,
        hasRules: rulesLoaded,
        hasConfig: fs.existsSync(jsonlPath),
        hasBenchmarkScript,
      }, loopOptions);

      ctx.ui.notify(
        rulesLoaded
          ? "Research mode ON — rules loaded from goal.md"
          : "Research mode ON — no goal.md found, setting up",
        "info",
      );

      const state = runtime.state;
      const activationSteer = await fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: readLastRun(workDir),
        research: buildResearchSnapshot(state),
      });

      resume.sendWhenReady(ctx, activationSteer ? `${activationSteer}\n\n${kickoff}` : kickoff);
    },
  });
}
