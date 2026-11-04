import type { ResearchSnapshot } from "../domain/research-snapshot.ts";
import {
  cloneResearchState,
  type ResearchState,
  type RunResult,
} from "../domain/research-state.ts";
import {
  applyRunResult,
  validateRunResultInput,
  type AppliedRunResult,
  type LogRunParams,
} from "../domain/run-result.ts";
import type { HookPayload } from "../execution/hooks.ts";
import { onResearchRunLogged } from "../protocol/research-phase.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { formatLogSummary } from "../ui/log-result-renderer.ts";
import type { WorkspaceExecAdapter } from "../workspace/research-workspace.ts";
import {
  applyKeptRunResultTransaction,
  restoreRejectedRunResultTransaction,
} from "../workspace/run-result-transaction.ts";
import {
  appendJournalEntry,
  appendRunResultToJournal,
  runResultJournalEntry,
} from "../persistence/research-journal.ts";
import {
  formatGateFailure,
  formatGateSummary,
  gateJournalEntry,
  runGate,
} from "../execution/gate-runner.ts";
import { checkResearchWorkspace } from "../workspace/research-workspace.ts";
import { activeResearch } from "../persistence/research-directory.ts";
import { readReviewerConfig } from "../persistence/goal-config.ts";
import { runReview } from "./review-workflow.ts";

export interface RecordRunResultDeps {
  pi: WorkspaceExecAdapter;
  workDir: string;
  /** Where goal.config.json lives; defaults to workDir. */
  configDir?: string;
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

interface PreparedRunResult {
  state: ResearchState;
  applied: AppliedRunResult;
}

export async function recordRunResult(params: LogRunParams, deps: RecordRunResultDeps): Promise<RecordRunResult> {
  const state = deps.state;
  const validationError = validateRunResultInput({
    state,
    params,
    lastRunChecks: deps.lastRunChecks,
  });
  if (validationError) return { ok: false, text: validationError };

  let gateSummary = "";
  let reviewSummary = "";
  let gateCriteriaIds: string[] | undefined;
  let gateHash: string | undefined;
  if (state.contract && params.status === "keep") {
    const workspace = await checkResearchWorkspace(deps.pi, deps.workDir);
    if (workspace.error) {
      return { ok: false, text: `❌ Gate could not read the workspace: ${workspace.error}` };
    }
    const gate = await runGate({
      pi: deps.pi,
      workDir: deps.workDir,
      contract: state.contract,
      state,
      metric: params.metric,
      metrics: params.metrics,
      changedPaths: workspace.userPaths,
      forceKeep: params.force_keep === true,
    });
    const gateError = appendJournalEntry(deps.workDir, gateJournalEntry(gate));
    if (gateError) return { ok: false, text: gateError };
    state.gates.push(gate);
    if (gate.verdict === "fail") return { ok: false, text: formatGateFailure(gate) };
    gateSummary = formatGateSummary(gate);
    gateCriteriaIds = gate.criteria
      .filter((verdict) => verdict.blocking && verdict.pass)
      .map((verdict) => verdict.criterionId);
    gateHash = gate.contractHash;
  }

  if (state.contract && params.status === "keep") {
    const reviewer = readReviewerConfig(deps.configDir ?? deps.workDir);
    if (reviewer) {
      try {
        const workspace = await checkResearchWorkspace(deps.pi, deps.workDir);
        const review = await runReview({
          pi: deps.pi,
          workDir: deps.workDir,
          contract: state.contract,
          state,
          reviewer,
          changedPaths: workspace.userPaths,
        });
        const reviewError = appendJournalEntry(deps.workDir, {
          type: "review",
          review: review.review,
        });
        if (reviewError) return { ok: false, text: reviewError };
        state.reviews.push(review.review);
        reviewSummary = review.text;
        if (review.deniedKeep) {
          return {
            ok: false,
            text: `${review.text}\n❌ Keep denied: the reviewer reproduced a blocking finding. Fix it and rerun, or log as discard with the finding in ASI.`,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (reviewer.blocking) {
          return { ok: false, text: `❌ Reviewer failed while blocking is enabled: ${message}` };
        }
        reviewSummary = `⚠️ Reviewer failed (advisory): ${message}`;
      }
    }
  }

  const prepared = prepareRunResult(state, params);
  let text = formatLogSummary({ state: prepared.state, applied: prepared.applied, params });
  if (gateSummary) text = `${gateSummary}\n${text}`;
  if (reviewSummary) text = `${reviewSummary}\n${text}`;

  const keepResult = await applyKeptRunResultTransaction({
    pi: deps.pi,
    workDir: deps.workDir,
    description: params.description,
    metricName: state.metricName,
    metric: params.metric,
    status: params.status,
    secondaryMetrics: prepared.applied.secondaryMetrics,
    criteriaIds: gateCriteriaIds,
    gateHash,
  });
  text += keepResult.text;
  if (keepResult.commit) prepared.applied.runResult.commit = keepResult.commit;

  const jsonlEntry = runResultJournalEntry(prepared.state.results.length, prepared.applied.runResult);
  const journalError = appendRunResultToJournal(deps.workDir, jsonlEntry);
  if (journalError) {
    return { ok: false, text: `${text}\n${journalError}` };
  }

  commitPreparedRunResult(state, prepared.state);
  deps.broadcastDashboardUpdate(deps.workDir);

  const restored = await restoreRejectedRunResultTransaction({
    pi: deps.pi,
    workDir: deps.workDir,
    status: params.status as "discard" | "crash" | "checks_failed",
    runNumber: prepared.applied.runCount,
    description: params.description,
    attemptsDir: activeResearch(deps.workDir).paths.attempts,
  });
  text += restored.text;
  if (restored.attempt) {
    const attemptError = appendJournalEntry(deps.workDir, {
      type: "attempt",
      attempt: restored.attempt,
    });
    if (attemptError) text += `\n${attemptError}`;
  }

  const afterSteer = await deps.fireHook({
    event: "after",
    cwd: deps.workDir,
    run_entry: jsonlEntry,
    research: deps.buildResearchSnapshot(state),
  });

  const limitReached = state.runLimit !== null && prepared.applied.runCount >= state.runLimit;
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
    runResult: prepared.applied.runResult,
    jsonlEntry,
    runCount: prepared.applied.runCount,
    limitReached,
    wallClockSeconds: deps.wallClockSeconds,
    afterSteer,
    beforeSteer,
  };
}

function prepareRunResult(state: ResearchState, params: LogRunParams): PreparedRunResult {
  const preparedState = cloneResearchState(state);
  return {
    state: preparedState,
    applied: applyRunResult(preparedState, params),
  };
}

function commitPreparedRunResult(state: ResearchState, preparedState: ResearchState): void {
  const committed = cloneResearchState(preparedState);
  state.results = committed.results;
  state.bestMetric = committed.bestMetric;
  state.bestDirection = committed.bestDirection;
  state.metricName = committed.metricName;
  state.metricUnit = committed.metricUnit;
  state.secondaryMetrics = committed.secondaryMetrics;
  state.name = committed.name;
  state.currentExperimentIndex = committed.currentExperimentIndex;
  state.runLimit = committed.runLimit;
  state.confidence = committed.confidence;
}

export function finishRecordedRunResult(runtime: SessionRuntime, limitReached: boolean): void {
  runtime.activeRun = null;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  onResearchRunLogged(runtime.loop, limitReached);
}
