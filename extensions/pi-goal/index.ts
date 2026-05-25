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
} from "@mariozechner/pi-coding-agent";
import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
} from "./execution/hooks.ts";
import {
  resetResearchPhaseForAgentStart,
  type ResearchProtocolOptions,
} from "./protocol/research-phase.ts";
import { resolveGoalShortcuts } from "./support/shortcuts.ts";
import { resolveWorkDir } from "./persistence/goal-config.ts";

import { checkResearchWorkspace } from "./workspace/research-workspace.ts";
import { researchJournalPath } from "./persistence/research-paths.ts";
import {
  createRuntimeStore,
  type SessionRuntime,
} from "./support/runtime.ts";
import { createDashboardServer } from "./ui/browser-dashboard.ts";
import { createDashboardOverlayController } from "./ui/dashboard-overlay.ts";
import { createWidgetController } from "./ui/widget.ts";
import { createResumeAdapter } from "./protocol/resume-scheduler.ts";
import { registerValidateResearchTool } from "./tools/validate.ts";
import { registerInitExperimentTool, registerStartExperimentTool } from "./tools/init.ts";
import { registerRunExperimentTool } from "./tools/run.ts";
import { registerLogExperimentTool } from "./tools/log.ts";
import {
  buildResearchSnapshot,
  readLastRunResult,
} from "./persistence/research-store.ts";
import { readResearchFileContract } from "./persistence/research-files.ts";
import {
  composeResearchCompactionResumeMessage,
  composeResearchResumeMessage,
  composeResearchSystemPrompt,
  shouldResumeResearchAfterCompact,
  shouldResumeResearchAfterTurn,
} from "./protocol/research-protocol.ts";
import { restoreActiveResearchRuntime } from "./persistence/research-runtime-restore.ts";
import { registerGoalCommand } from "./tools/goal-command.ts";

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
  const loopOptions: ResearchProtocolOptions = {
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

  const shouldResearchAutoResumeAfterTurn = (runtime: SessionRuntime): boolean =>
    shouldResumeResearchAfterTurn(runtime, loopOptions);

  const shouldResearchAutoResumeAfterCompact = (runtime: SessionRuntime): boolean =>
    shouldResumeResearchAfterCompact(runtime);

  const notifyAutoResumeLimitReached = (ctx: ExtensionContext): void => {
    ctx.ui.notify(
      `Research auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
      "info",
    );
  };

  const composeResearchPhaseResumeMessage = (_ctx: ExtensionContext): string =>
    composeResearchResumeMessage(getRuntime(_ctx), loopOptions);

  const composeResearchPhaseCompactionResumeMessage = (_ctx: ExtensionContext): string =>
    composeResearchCompactionResumeMessage(loopOptions);

  const resume = createResumeAdapter({
    pi,
    loopOptions,
    settledWindowMs: SETTLED_WINDOW_MS,
    notifyAutoResumeLimitReached,
    composeResearchPhaseResumeMessage,
  });

  const readLastRun = readLastRunResult;

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

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    resume.cancel(runtime);
    restoreActiveResearchRuntime({
      runtime,
      workDir: resolveWorkDir(ctx.cwd),
      ctxCwd: ctx.cwd,
      sessionBranch: ctx.sessionManager.getBranch(),
    });
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
    resetResearchPhaseForAgentStart(runtime.loop);
    resume.pause(runtime);
  });


  pi.on("session_before_compact", async (_event, ctx) => {
    resume.pause(getRuntime(ctx));
  });

  pi.on("session_compact", async (_event, ctx) => {
    resume.ensure(ctx, getRuntime(ctx), shouldResearchAutoResumeAfterCompact, composeResearchPhaseCompactionResumeMessage);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.activeRun = null;
    dashboardOverlay.requestRender();
    resume.ensure(ctx, runtime, shouldResearchAutoResumeAfterTurn);
  });

  // When in goal mode, add phase-specific loop control to the system prompt.
  // Only paths and required actions — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    const workDir = resolveWorkDir(ctx.cwd);
    const extra = composeResearchSystemPrompt(
      runtime.loop,
      readResearchFileContract(workDir),
      loopOptions,
    );

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
    pi.registerShortcut(shortcuts.toggleDashboard as any, {
      description: "Toggle goal dashboard",
      handler: async (ctx) => {
        const runtime = getRuntime(ctx);
        const state = runtime.state;
        if (state.results.length === 0) {
          if (!runtime.loop.mode && !readResearchFileContract(resolveWorkDir(ctx.cwd)).hasRules) {
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
    pi.registerShortcut(shortcuts.fullscreenDashboard as any, {
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
  // /goal command
  // -----------------------------------------------------------------------

  registerGoalCommand(pi, {
    getRuntime,
    updateWidget,
    clearSessionUi,
    reconstructState,
    stopDashboardServer,
    exportDashboard: (ctx, workDir) => dashboardServer.export(ctx, workDir),
    resume,
    loopOptions,
    fireHook,
    buildResearchSnapshot,
    checkWorkspace: checkResearchWorkspace,
  });
}
