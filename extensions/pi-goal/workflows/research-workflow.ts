import * as fs from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ResearchSnapshot } from "../domain/research-snapshot.ts";
import {
  cloneResearchState,
  currentRuns,
  isBetter,
  type ResearchState,
  type RunResult,
} from "../domain/research-state.ts";
import {
  researchValidationResult,
  type ResearchValidationIssue,
  type ResearchValidationResult,
} from "../domain/research-validation.ts";
import {
  applyRunResult,
  validateRunResultInput,
  type LogRunParams,
} from "../domain/run-result.ts";
import {
  isGoalShCommand,
  runExperiment,
  type ExperimentRunUpdate,
  type RunDetails,
} from "../execution/experiment-runner.ts";
import type { HookPayload } from "../execution/hooks.ts";
import { shouldUseScriptCommandOnly } from "../execution/research-command-policy.ts";
import { validateResearchDryRun, type ResearchDryRunExecAdapter } from "../execution/research-dry-run.ts";
import { readRunLimit } from "../persistence/goal-config.ts";
import { ensureActiveResearch } from "../persistence/research-directory.ts";
import { validateResearchFiles } from "../persistence/research-files.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { appendRunResultToJournal, runResultJournalEntry } from "../persistence/run-result-journal-writer.ts";
import {
  onResearchInitialized,
  onResearchRunFinished,
  researchAwaitingLogBlockMessage,
  shouldBlockResearchRun,
} from "../protocol/research-phase.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { formatLogSummary } from "../ui/log-result-renderer.ts";
import { buildRunExperimentResponseText } from "../ui/run-result-renderer.ts";
import {
  checkResearchWorkspace,
  formatWorkspaceSafetyError,
  type WorkspaceExecAdapter,
} from "../workspace/research-workspace.ts";
import { applyKeptRunResultTransaction, restoreRejectedRunResultTransaction } from "../workspace/run-result-transaction.ts";

export type { LogRunParams } from "../domain/run-result.ts";
export type { ResearchValidationIssue, ResearchValidationResult };
export { isBetter };

// ---------------------------------------------------------------------------
// Experiment configuration: initialize Research or start a later Experiment.
// ---------------------------------------------------------------------------

export type ExperimentConfigKind = "init_goal" | "start_goal";

export interface ExperimentConfigParams {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: string;
}

export interface ExperimentConfigWorkflowDeps {
  pi: Pick<ExtensionAPI, "exec">;
  runtime: SessionRuntime;
  workDir: string;
  ctxCwd: string;
  kind: ExperimentConfigKind;
  title: string;
  fireHook(payload: HookPayload): Promise<string | null>;
  readLastRun(workDir: string): Record<string, unknown> | null;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
  broadcastDashboardUpdate(workDir: string): void;
}

export interface ExperimentConfigWorkflowBlocked {
  ok: false;
  text: string;
}

export interface ExperimentConfigWorkflowSuccess {
  ok: true;
  text: string;
  state: ResearchState;
  steer: string | null;
}

export type ExperimentConfigWorkflowResult =
  | ExperimentConfigWorkflowBlocked
  | ExperimentConfigWorkflowSuccess;

export async function executeExperimentConfigWorkflow(
  params: ExperimentConfigParams,
  deps: ExperimentConfigWorkflowDeps,
): Promise<ExperimentConfigWorkflowResult> {
  const { runtime, workDir, ctxCwd, kind } = deps;
  const state = runtime.state;
  const startsLaterExperiment = state.results.length > 0;

  if (kind === "init_goal" && startsLaterExperiment) {
    return {
      ok: false,
      text: "❌ init_goal initializes the active research and first experiment only. The active research already has runs; use start_goal to open a new experiment with a fresh baseline.",
    };
  }

  const dirtyCheck = await checkResearchWorkspace(deps.pi, workDir);
  const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
  if (dirtyBlock) {
    return { ok: false, text: `❌ ${dirtyBlock}` };
  }

  applyExperimentConfigState(state, params, startsLaterExperiment, ctxCwd);

  const journalError = writeExperimentConfig(workDir, state);
  if (journalError) {
    return { ok: false, text: journalError };
  }
  deps.broadcastDashboardUpdate(workDir);

  const wasInactive = !runtime.loop.mode;
  onResearchInitialized(runtime.loop);

  let steer: string | null = null;
  if (wasInactive) {
    steer = await deps.fireHook({
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: deps.readLastRun(workDir),
      research: deps.buildResearchSnapshot(state),
    });
  }

  return {
    ok: true,
    text: experimentConfigSuccessText({
      state,
      title: deps.title,
      startsLaterExperiment,
      workDir,
      ctxCwd,
    }),
    state: cloneResearchState(state),
    steer,
  };
}

function applyExperimentConfigState(
  state: ResearchState,
  params: ExperimentConfigParams,
  startsLaterExperiment: boolean,
  ctxCwd: string,
): void {
  state.name = params.name;
  state.metricName = params.metric_name;
  state.metricUnit = params.metric_unit ?? "";
  if (params.direction === "lower" || params.direction === "higher") {
    state.bestDirection = params.direction;
  }
  if (startsLaterExperiment) {
    state.currentExperimentIndex++;
  }
  state.bestMetric = null;
  state.secondaryMetrics = [];
  state.confidence = null;
  state.runLimit = readRunLimit(ctxCwd);
}

function writeExperimentConfig(workDir: string, state: ResearchState): string | null {
  try {
    const jsonlPath = ensureActiveResearch(workDir).paths.journal;
    const config = JSON.stringify({
      type: "config",
      name: state.name,
      metricName: state.metricName,
      metricUnit: state.metricUnit,
      bestDirection: state.bestDirection,
    });
    if (fs.existsSync(jsonlPath)) {
      fs.appendFileSync(jsonlPath, config + "\n");
    } else {
      fs.writeFileSync(jsonlPath, config + "\n");
    }
    return null;
  } catch (error) {
    return `⚠️ Failed to write goal.jsonl: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function experimentConfigSuccessText(options: {
  state: ResearchState;
  title: string;
  startsLaterExperiment: boolean;
  workDir: string;
  ctxCwd: string;
}): string {
  const { state, title, startsLaterExperiment, workDir, ctxCwd } = options;
  const experimentStartNote = startsLaterExperiment
    ? " (new experiment started — previous runs archived, new baseline needed)"
    : "";
  const limitNote = state.runLimit !== null
    ? `\nRun limit: ${state.runLimit} (from goal.config.json)`
    : "";
  const workDirNote = workDir !== ctxCwd ? `\nWorking directory: ${workDir}` : "";
  return `✅ ${title}: "${state.name}"${experimentStartNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to goal.jsonl. Now run the baseline with run_goal.`;
}

// ---------------------------------------------------------------------------
// Research validation.
// ---------------------------------------------------------------------------

export type ValidatorExecAdapter = ResearchDryRunExecAdapter;

export async function validateResearch(options: {
  workDir: string;
  pi: ValidatorExecAdapter;
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<ResearchValidationResult> {
  const { workDir, pi, dryRun = true, timeoutMs = 60_000 } = options;
  const fileValidation = validateResearchFiles(workDir);
  const metricName = fileValidation.contract.metricName;
  const dryRunValidation = await validateResearchDryRun({
    workDir,
    pi,
    contract: fileValidation.contract,
    metricName,
    dryRun,
    timeoutMs,
  });

  return researchValidationResult({
    workDir,
    metricName,
    issues: [...fileValidation.issues, ...dryRunValidation.issues],
    parsedMetrics: dryRunValidation.parsedMetrics,
  });
}

export function formatResearchValidationResult(result: ResearchValidationResult): string {
  const status = result.ok ? "✅ Research is valid" : "❌ Research is invalid";
  const lines = [status, `Working directory: ${result.workDir}`];
  if (result.metricName) lines.push(`Primary metric: ${result.metricName}`);
  if (result.parsedMetrics && Object.keys(result.parsedMetrics).length > 0) {
    lines.push(`Parsed metrics: ${Object.entries(result.parsedMetrics).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  if (result.issues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of result.issues) {
      lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run execution.
// ---------------------------------------------------------------------------

export interface RunExperimentWorkflowParams {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

export interface RunExperimentWorkflowDeps {
  pi: Pick<ExtensionAPI, "exec">;
  workDir: string;
  runtime: SessionRuntime;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  onActiveRunChange(): void;
}

export interface RunExperimentWorkflowBlocked {
  ok: false;
  text: string;
  details?: RunDetails;
}

export interface RunExperimentWorkflowSuccess {
  ok: true;
  text: string;
  details: RunDetails & { truncation?: unknown; fullOutputPath?: string };
}

export type RunExperimentWorkflowResult = RunExperimentWorkflowBlocked | RunExperimentWorkflowSuccess;

export async function executeRunExperimentWorkflow(
  params: RunExperimentWorkflowParams,
  deps: RunExperimentWorkflowDeps,
): Promise<RunExperimentWorkflowResult> {
  const { runtime, workDir } = deps;
  const state = runtime.state;

  if (shouldBlockResearchRun(runtime.loop)) {
    return { ok: false, text: researchAwaitingLogBlockMessage(runtime.loop) };
  }

  if (state.runLimit !== null) {
    const runCount = currentRuns(state.results, state.currentExperimentIndex).length;
    if (runCount >= state.runLimit) {
      return {
        ok: false,
        text: `🛑 Maximum runs reached (${state.runLimit}) for the current experiment. To continue with a fresh baseline, call start_goal.`,
      };
    }
  }

  const fileContract = readResearchFileContract(workDir);
  if (shouldUseScriptCommandOnly(fileContract) && !isGoalShCommand(params.command)) {
    return {
      ok: false,
      text: `❌ goal.sh exists — you must run it instead of a custom command.\n\nFound: ${fileContract.scriptPath}\nYour command: ${params.command}\n\nUse: run_goal({ command: "bash goal.sh" }) or run_goal({ command: "./goal.sh" })`,
      details: blockedRunDetails(params.command, state.metricName, state.metricUnit),
    };
  }

  runtime.activeRun = { startedAt: Date.now(), command: params.command };
  deps.onActiveRunChange();

  const { details, llmOutput, truncation, fullOutputPath } = await runExperiment({
    command: params.command,
    workDir,
    timeoutSeconds: params.timeout_seconds,
    checksTimeoutSeconds: params.checks_timeout_seconds,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    signal: deps.signal,
    onUpdate: deps.onUpdate,
    pi: deps.pi,
  }).finally(() => {
    runtime.activeRun = null;
    deps.onActiveRunChange();
  });

  runtime.lastRunDuration = details.durationSeconds;
  runtime.lastRunChecks = details.checksPass !== null
    ? { pass: details.checksPass, output: details.checksOutput, duration: details.checksDuration }
    : null;

  onResearchRunFinished(runtime.loop, {
    command: details.command,
    passed: details.passed,
    crashed: details.crashed,
    timedOut: details.timedOut,
    checksPass: details.checksPass,
    checksTimedOut: details.checksTimedOut,
    parsedPrimary: details.parsedPrimary,
    parsedMetrics: details.parsedMetrics,
    metricName: details.metricName,
    metricUnit: details.metricUnit,
  });

  const text = buildRunExperimentResponseText({
    details,
    llmOutput,
    truncation,
    fullOutputPath,
    requirePrimaryMetric: shouldUseScriptCommandOnly(fileContract),
    bestMetric: state.bestMetric,
  });

  return {
    ok: true,
    text,
    details: { ...details, truncation, fullOutputPath },
  };
}

function blockedRunDetails(command: string, metricName: string, metricUnit: string): RunDetails {
  return {
    command,
    exitCode: null,
    durationSeconds: 0,
    passed: false,
    crashed: true,
    timedOut: false,
    tailOutput: "",
    checksPass: null,
    checksTimedOut: false,
    checksOutput: "",
    checksDuration: 0,
    parsedMetrics: null,
    parsedPrimary: null,
    metricName,
    metricUnit,
  };
}

// ---------------------------------------------------------------------------
// Run Result logging.
// ---------------------------------------------------------------------------

export interface RecordRunResultDeps {
  pi: WorkspaceExecAdapter;
  workDir: string;
  state: ResearchState;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  wallClockSeconds: number | null;
  fireHook(payload: HookPayload): Promise<string | null>;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
  broadcastDashboardUpdate(workDir: string): void;
}

export interface RecordRunResultBlocked {
  ok: false;
  text: string;
}

export interface RecordRunResultSuccess {
  ok: true;
  text: string;
  runResult: RunResult;
  jsonlEntry: Record<string, unknown>;
  runCount: number;
  limitReached: boolean;
  wallClockSeconds: number | null;
  afterSteer: string | null;
  beforeSteer: string | null;
}

export type RecordRunResult = RecordRunResultBlocked | RecordRunResultSuccess;

export async function recordRunResult(params: LogRunParams, deps: RecordRunResultDeps): Promise<RecordRunResult> {
  const state = deps.state;
  const validationError = validateRunResultInput({
    state,
    params,
    lastRunChecks: deps.lastRunChecks,
  });
  if (validationError) return { ok: false, text: validationError };

  const applied = applyRunResult(state, params);
  let text = formatLogSummary({ state, applied, params });

  const keepResult = await applyKeptRunResultTransaction({
    pi: deps.pi,
    workDir: deps.workDir,
    description: params.description,
    metricName: state.metricName,
    metric: params.metric,
    status: params.status,
    secondaryMetrics: applied.secondaryMetrics,
  });
  text += keepResult.text;
  if (keepResult.commit) applied.runResult.commit = keepResult.commit;

  const jsonlEntry = runResultJournalEntry(state.results.length, applied.runResult);
  const journalError = appendRunResultToJournal(deps.workDir, jsonlEntry);
  if (journalError) {
    text += `\n${journalError}`;
  } else {
    deps.broadcastDashboardUpdate(deps.workDir);
  }

  text += await restoreRejectedRunResultTransaction({
    pi: deps.pi,
    workDir: deps.workDir,
    status: params.status,
  });

  const afterSteer = await deps.fireHook({
    event: "after",
    cwd: deps.workDir,
    run_entry: jsonlEntry,
    research: deps.buildResearchSnapshot(state),
  });

  const limitReached = state.runLimit !== null && applied.runCount >= state.runLimit;
  let beforeSteer: string | null = null;
  if (!limitReached) {
    beforeSteer = await deps.fireHook({
      event: "before",
      cwd: deps.workDir,
      next_run: state.results.length + 1,
      last_run: jsonlEntry,
      research: deps.buildResearchSnapshot(state),
    });
  }

  return {
    ok: true,
    text,
    runResult: applied.runResult,
    jsonlEntry,
    runCount: applied.runCount,
    limitReached,
    wallClockSeconds: deps.wallClockSeconds,
    afterSteer,
    beforeSteer,
  };
}
