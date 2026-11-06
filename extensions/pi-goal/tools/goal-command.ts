import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseGoalIntent } from "./goal-intent.ts";

import { createResearchState } from "../domain/research-state.ts";
import { buildResearchSnapshot } from "../domain/research-snapshot.ts";
import { resolveResearchToolContext, type ResearchToolPort } from "./tool-adapter.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { appendJournalEntry, deleteJournal, policyJournalEntry, readLastRunResult } from "../persistence/research-journal.ts";
import { selectActiveResearch } from "../persistence/research-directory.ts";
import { deactivateResearch, type ResearchProtocolOptions } from "../protocol/research-phase.ts";
import { startResearchActivation } from "../protocol/research-protocol.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../workspace/research-workspace.ts";

export interface GoalCommandDeps extends ResearchToolPort {
  clearSessionUi(ctx: ExtensionContext): void;
  reconstructState(ctx: ExtensionContext): void;
  stopDashboardServer(): void;
  exportDashboard(ctx: ExtensionContext, workDir: string): Promise<void>;
  loopOptions: ResearchProtocolOptions;
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
  const intent = parseGoalIntent(args);

  switch (intent.kind) {
    case "help":
      ctx.ui.notify(goalCommandHelp(), "info");
      return;
    case "off":
      turnResearchOff(ctx, deps, runtime);
      return;
    case "clear":
      clearActiveResearchJournal(ctx, deps, runtime);
      return;
    case "export": {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) {
        ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
        return;
      }
      await deps.exportDashboard(ctx, contextResult.context.workDir);
      return;
    }
    case "reinit":
      requestExperimentStart(pi, ctx, deps, runtime);
      return;
    case "select-usage":
      ctx.ui.notify("Usage: /goal select <research-id>", "info");
      return;
    case "select":
      selectResearch(ctx, deps, intent.researchId);
      return;
    case "allow-tests":
      toggleTestEdits(ctx, deps, runtime, true);
      return;
    case "protect-tests":
      toggleTestEdits(ctx, deps, runtime, false);
      return;
    case "allow-benchmark":
      toggleBenchmarkEdits(ctx, deps, runtime, true);
      return;
    case "protect-benchmark":
      toggleBenchmarkEdits(ctx, deps, runtime, false);
      return;
    case "start":
      await startOrResumeResearch(pi, deps, ctx, runtime, intent.goal);
  }
}

function goalCommandHelp(): string {
  return [
    "Usage: /goal [off|clear|export|reinit|select <research-id>|allow-tests|protect-tests|allow-benchmark|protect-benchmark|<text>]",
    "",
    "<text> enters goal mode and starts or resumes the loop.",
    "reinit starts a new experiment in the active research with a fresh baseline.",
    "select <research-id> switches the active research directory.",
    "off leaves goal mode.",
    "clear deletes goal.jsonl and turns goal mode off.",
    "export opens a local live dashboard for goal.jsonl in your browser.",
    "allow-tests unlocks test-file edits for the sealed research; protect-tests restores the block.",
    "allow-benchmark unlocks goal.sh / goal.checks.sh edits; protect-benchmark restores the block.",
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
  deps.stopDashboardServer();
  deps.clearSessionUi(ctx);
  if (wasRunning) ctx.abort();
  ctx.ui.notify(
    wasRunning ? "Research mode OFF — aborting current run" : "Research mode OFF",
    "info",
  );
}

function selectResearch(ctx: ExtensionContext, deps: GoalCommandDeps, researchId: string): void {
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  const selectedResearch = selectActiveResearch(contextResult.context.workDir, researchId);
  deps.reconstructState(ctx);
  ctx.ui.notify(`Active research selected: ${selectedResearch.id}`, "info");
}

function requestExperimentStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: GoalCommandDeps,
  runtime: SessionRuntime,
): void {
  if (runtime.state.results.length === 0) {
    ctx.ui.notify("No runs yet — use init_goal to initialize the active research first", "info");
    return;
  }
  sendWhenReady(pi, ctx, [
    "Start a new Experiment in the active Research now.",
    "Call start_goal with the updated metric, unit, and direction, then run the new baseline with run_goal and log_goal.",
    "Use this only if the Research target is unchanged but the primary metric, direction, workload, measurement method, or baseline comparability changed.",
  ].join("\n"));
}

function toggleTestEdits(
  ctx: ExtensionContext,
  deps: GoalCommandDeps,
  runtime: SessionRuntime,
  allow: boolean,
): void {
  if (!runtime.state.contract) {
    ctx.ui.notify("No frozen contract yet — test protection starts after freeze_criteria.", "info");
    return;
  }
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  runtime.state.testEditsAllowed = allow;
  const journalError = appendJournalEntry(
    contextResult.context.workDir,
    policyJournalEntry(allow, runtime.state.benchmarkEditsAllowed),
  );
  if (journalError) {
    ctx.ui.notify(journalError, "error");
    return;
  }
  ctx.ui.notify(
    allow
      ? "Test edits allowed for this research. Gate L2 will not block test-file changes."
      : "Test protection restored for this research.",
    "info",
  );
}

function toggleBenchmarkEdits(
  ctx: ExtensionContext,
  deps: GoalCommandDeps,
  runtime: SessionRuntime,
  allow: boolean,
): void {
  if (!runtime.state.contract) {
    ctx.ui.notify("No frozen contract yet — benchmark protection starts after freeze_criteria.", "info");
    return;
  }
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  runtime.state.benchmarkEditsAllowed = allow;
  const journalError = appendJournalEntry(
    contextResult.context.workDir,
    policyJournalEntry(runtime.state.testEditsAllowed, allow),
  );
  if (journalError) {
    ctx.ui.notify(journalError, "error");
    return;
  }
  ctx.ui.notify(
    allow
      ? "Benchmark edits allowed for this research. Seal protection for goal.sh / goal.checks.sh is off."
      : "Benchmark protection restored for this research.",
    "info",
  );
}

function sendWhenReady(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }
  pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function clearActiveResearchJournal(ctx: ExtensionContext, deps: GoalCommandDeps, runtime: SessionRuntime): void {
  const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
  if (!contextResult.ok) {
    ctx.ui.notify(contextResult.text.replace(/^❌\s*/, ""), "error");
    return;
  }
  deactivateResearch(runtime.loop);
  runtime.dashboardExpanded = false;
  runtime.lastRunChecks = null;
  runtime.activeRun = null;
  runtime.state = createResearchState();
  deps.stopDashboardServer();
  deps.researchChanged(ctx, contextResult.context.workDir);

  const removal = deleteJournal(contextResult.context.workDir);
  if (removal.error) {
    ctx.ui.notify(`Failed to delete goal.jsonl: ${removal.error}`, "error");
    return;
  }
  ctx.ui.notify(
    removal.deleted ? "Deleted goal.jsonl and turned goal mode OFF" : "No goal.jsonl found. Research mode OFF",
    "info",
  );
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
  const dirtyCheck = await checkResearchWorkspace(pi, workDir);
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
    research: buildResearchSnapshot(state),
  });

  sendWhenReady(
    pi,
    ctx,
    activationSteer ? `${activationSteer}\n\n${activation.kickoff}` : activation.kickoff,
  );
}
