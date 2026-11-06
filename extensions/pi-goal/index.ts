/**
 * goal — Pi Extension
 *
 * Generic autonomous research loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * This file is the composition root: it builds the session-scoped runtimes and
 * views, then hands one port to each registration module. Behaviour lives in
 * `tools/` (host adapters), `protocol/` (phase and guards), and `workflows/`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
} from "./execution/hooks.ts";
import { resolveGoalShortcuts } from "./support/shortcuts.ts";
import { resolveWorkDir } from "./persistence/goal-config.ts";
import { activeResearch } from "./persistence/research-directory.ts";
import {
  createRuntimeStore,
  type SessionRuntime,
} from "./support/runtime.ts";
import { createDashboardServer } from "./ui/browser-dashboard.ts";
import { createDashboardOverlayController } from "./ui/dashboard-overlay.ts";
import { createWidgetController } from "./ui/widget.ts";
import { restoreActiveResearchRuntime } from "./support/research-runtime-restore.ts";
import type { ResearchToolPort } from "./tools/tool-adapter.ts";
import {
  registerDashboardShortcuts,
  registerSessionHandlers,
  type SessionHandlerDeps,
} from "./tools/session-handlers.ts";
import { registerValidateResearchTool } from "./tools/validate.ts";
import { registerInitExperimentTool, registerStartExperimentTool } from "./tools/init.ts";
import { registerRunExperimentTool } from "./tools/run.ts";
import { registerLogExperimentTool } from "./tools/log.ts";
import { registerGoalCommand } from "./tools/goal-command.ts";
import { registerGoalContractTools } from "./tools/contract.ts";
import { registerCheckGoalTool } from "./tools/check.ts";
import { registerReviewGoalTool } from "./tools/review.ts";

export default function goalExtension(pi: ExtensionAPI) {
  const loopOptions = {
    maxAutoResumeTurns: 200,
    maxActivationTurns: 50,
    benchmarkGuardrail:
      "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.",
  };

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

  // -------------------------------------------------------------------------
  // Session-scoped runtimes and views
  // -------------------------------------------------------------------------

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): SessionRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  const dashboardOverlay = createDashboardOverlayController();
  const widget = createWidgetController({ dashboardHintVariants });
  const dashboardServer = createDashboardServer();

  const updateWidget = (ctx: ExtensionContext) => widget.update(ctx, getRuntime(ctx));

  const fireHook = async (payload: HookPayload): Promise<string | null> => {
    const result = await runHook(payload);
    appendHookLogEntryIfConfigured(activeResearch(payload.cwd).paths.journal, payload.event, result);
    return steerMessageFor(payload.event, result);
  };

  // One announcement for the widget, the fullscreen overlay, and the browser
  // dashboard: they all mirror research state, so a caller never has to pick.
  const researchChanged = (ctx: ExtensionContext, workDir: string): void => {
    updateWidget(ctx);
    dashboardOverlay.requestRender();
    dashboardServer.broadcast(workDir);
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    dashboardOverlay.clear();
    widget.clear(ctx);
  };

  const reconstructState = (ctx: ExtensionContext) => {
    restoreActiveResearchRuntime({
      runtime: getRuntime(ctx),
      workDir: resolveWorkDir(ctx.cwd),
      ctxCwd: ctx.cwd,
      sessionBranch: ctx.sessionManager.getBranch(),
    });
    updateWidget(ctx);
  };

  // -------------------------------------------------------------------------
  // Ports: one per registration module
  // -------------------------------------------------------------------------

  const toolPort: ResearchToolPort = { getRuntime, researchChanged, exec: pi, fireHook };

  const sessionDeps: SessionHandlerDeps = {
    port: toolPort,
    loopOptions,
    shortcuts,
    reconstruct: reconstructState,
    clearSessionUi,
    clearOverlay: () => dashboardOverlay.clear(),
    requestOverlayRender: () => dashboardOverlay.requestRender(),
    openDashboard: (ctx, runtime) => dashboardOverlay.open(ctx, runtime),
    stopDashboard: () => dashboardServer.stop(),
    clearRuntime: (ctx) => runtimeStore.clear(getSessionKey(ctx)),
  };

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  registerSessionHandlers(pi, sessionDeps);
  registerDashboardShortcuts(pi, sessionDeps);

  registerValidateResearchTool(pi);
  registerInitExperimentTool(pi, toolPort);
  registerStartExperimentTool(pi, toolPort);
  registerGoalContractTools(pi, toolPort);
  registerCheckGoalTool(pi, toolPort);
  registerReviewGoalTool(pi, toolPort);
  registerRunExperimentTool(pi, toolPort);
  registerLogExperimentTool(pi, toolPort);

  registerGoalCommand(pi, {
    ...toolPort,
    clearSessionUi,
    reconstructState,
    stopDashboardServer: () => dashboardServer.stop(),
    exportDashboard: (ctx, workDir) => dashboardServer.export(ctx, workDir),
    loopOptions,
  });
}
