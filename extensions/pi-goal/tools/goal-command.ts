import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createResearchState, type ResearchState } from "../domain/research-state.ts";
import type { HookPayload } from "../execution/hooks.ts";
import type { ResearchSnapshot } from "../domain/research-snapshot.ts";
import { resolveResearchToolContext } from "./tool-adapter.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { readLastRunResult } from "../persistence/research-journal.ts";
import { activeResearch, selectActiveResearch } from "../persistence/research-directory.ts";
import { clearResearchPhase, deactivateResearch, type ResearchProtocolOptions } from "../protocol/research-phase.ts";
import { startResearchActivation } from "../protocol/research-protocol.ts";
import type { ResumeAdapter } from "../protocol/resume-scheduler.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../workspace/research-workspace.ts";

export interface GoalCommandDeps {
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  clearSessionUi(ctx: ExtensionContext): void;
  reconstructState(ctx: ExtensionContext): void;
  stopDashboardServer(): void;
  exportDashboard(ctx: ExtensionContext, workDir: string): Promise<void>;
  resume: Pick<ResumeAdapter, "cancel" | "sendWhenReady">;
  loopOptions: ResearchProtocolOptions;
  fireHook(payload: HookPayload): Promise<string | null>;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
  checkWorkspace(pi: ExtensionAPI, workDir: string): ReturnType<typeof checkResearchWorkspace>;
}

export function registerGoalCommand(pi: ExtensionAPI, deps: GoalCommandDeps): void {
  pi.registerCommand("goal", {
    description: "Start, stop, clear, or resume goal mode",
    handler: async (args, ctx) => handleGoalCommand(pi, deps, args, ctx),
  });
}

async function handleGoalCommand(
  pi: ExtensionAPI,
  deps: GoalCommandDeps,
  args: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  const runtime = deps.getRuntime(ctx);
  const trimmedArgs = (args ?? "").trim();
  const command = trimmedArgs.toLowerCase();

  if (!trimmedArgs) {
    ctx.ui.notify(goalCommandHelp(), "info");
    return;
  }

  if (command === "off") {
    turnResearchOff(ctx, deps, runtime);
    return;
  }

  if (command === "export") {
    const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
    if (!contextResult.ok) {
      ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
      return;
    }
    await deps.exportDashboard(ctx, contextResult.context.workDir);
    return;
  }

  if (command === "select") {
    ctx.ui.notify("Usage: /goal select <research-id>", "info");
    return;
  }

  if (command.startsWith("select ")) {
    selectResearch(ctx, deps, trimmedArgs);
    return;
  }

  if (command === "reinit") {
    requestExperimentStart(ctx, deps, runtime);
    return;
  }

  if (command === "clear") {
    clearActiveResearchJournal(ctx, deps, runtime);
    return;
  }

  await startOrResumeResearch(pi, deps, ctx, runtime, trimmedArgs);
}

function goalCommandHelp(): string {
  return [
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
}

function turnResearchOff(ctx: ExtensionContext, deps: GoalCommandDeps, runtime: SessionRuntime): void {
  const wasRunning = !ctx.isIdle();

  deactivateResearch(runtime.loop);
  runtime.dashboardExpanded = false;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.activeRun = null;
  deps.resume.cancel(runtime);
  deps.stopDashboardServer();
  deps.clearSessionUi(ctx);
  if (wasRunning) ctx.abort();
  ctx.ui.notify(
    wasRunning ? "Research mode OFF — aborting current run" : "Research mode OFF",
    "info",
  );
}

function selectResearch(ctx: ExtensionContext, deps: GoalCommandDeps, trimmedArgs: string): void {
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  const researchId = trimmedArgs.slice("select".length).trim();
  if (!researchId) {
    ctx.ui.notify("Usage: /goal select <research-id>", "info");
    return;
  }
  const selectedResearch = selectActiveResearch(contextResult.context.workDir, researchId);
  deps.reconstructState(ctx);
  ctx.ui.notify(`Active research selected: ${selectedResearch.id}`, "info");
}

function requestExperimentStart(ctx: ExtensionContext, deps: GoalCommandDeps, runtime: SessionRuntime): void {
  if (runtime.state.results.length === 0) {
    ctx.ui.notify("No runs yet — use init_goal to initialize the active research first", "info");
    return;
  }
  deps.resume.sendWhenReady(ctx, [
    "Start a new Experiment in the active Research now.",
    "Call start_goal with the updated metric, unit, and direction, then run the new baseline with run_goal and log_goal.",
    "Use this only if the Research target is unchanged but the primary metric, direction, workload, measurement method, or baseline comparability changed.",
  ].join("\n"));
}

function clearActiveResearchJournal(ctx: ExtensionContext, deps: GoalCommandDeps, runtime: SessionRuntime): void {
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  const jsonlPath = activeResearch(contextResult.context.workDir).paths.journal;
  clearResearchPhase(runtime.loop);
  runtime.dashboardExpanded = false;
  runtime.lastRunChecks = null;
  runtime.activeRun = null;
  deps.resume.cancel(runtime);
  runtime.state = createResearchState();
  deps.stopDashboardServer();
  deps.updateWidget(ctx);

  if (fs.existsSync(jsonlPath)) {
    try {
      fs.unlinkSync(jsonlPath);
      ctx.ui.notify("Deleted goal.jsonl and turned goal mode OFF", "info");
    } catch (error) {
      ctx.ui.notify(
        `Failed to delete goal.jsonl: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  } else {
    ctx.ui.notify("No goal.jsonl found. Research mode OFF", "info");
  }
}

async function startOrResumeResearch(
  pi: ExtensionAPI,
  deps: GoalCommandDeps,
  ctx: ExtensionContext,
  runtime: SessionRuntime,
  userGoal: string,
): Promise<void> {
  if (runtime.loop.mode) {
    ctx.ui.notify("Research already active — use '/goal off' to stop first", "info");
    return;
  }

  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  const workDir = contextResult.context.workDir;
  const dirtyCheck = await deps.checkWorkspace(pi, workDir);
  const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
  if (dirtyBlock) {
    ctx.ui.notify(dirtyBlock, "error");
    return;
  }

  const activation = startResearchActivation(
    runtime.loop,
    readResearchFileContract(workDir),
    userGoal,
    deps.loopOptions,
  );
  ctx.ui.notify(activation.notification, "info");

  const state = runtime.state;
  const activationSteer = await deps.fireHook({
    event: "before",
    cwd: workDir,
    next_run: state.results.length + 1,
    last_run: readLastRunResult(workDir),
    research: deps.buildResearchSnapshot(state),
  });

  deps.resume.sendWhenReady(
    ctx,
    activationSteer ? `${activationSteer}\n\n${activation.kickoff}` : activation.kickoff,
  );
}
