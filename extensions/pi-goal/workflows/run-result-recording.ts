import type { ResearchSnapshot } from "../domain/research-snapshot.ts";
import {
  cloneResearchState,
  commitResearchState,
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
import type { HostExec } from "../support/exec.ts";
import {
  settleRunWorkspace,
  type RunWorkspaceSettlement,
} from "../workspace/run-result-transaction.ts";
import {
  appendJournalEntry,
  appendRunResultToJournal,
  runResultJournalEntry,
} from "../persistence/research-journal.ts";
import {
  formatGateFailure,
  formatGateSummary,
} from "../execution/gate-runner.ts";
import { checkResearchWorkspace } from "../workspace/research-workspace.ts";
import { activeResearch } from "../persistence/research-directory.ts";
import { readReviewerConfig } from "../persistence/goal-config.ts";
import { gatePassed, recordGate } from "./gate-workflow.ts";
import { recordReview } from "./review-workflow.ts";

export interface RecordRunResultDeps {
  pi: HostExec;
  workDir: string;
  /** Where goal.config.json lives; defaults to workDir. */
  configDir?: string;
  state: ResearchState;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  wallClockSeconds: number | null;
  fireHook(payload: HookPayload): Promise<string | null>;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
}

export interface RecordRunResultBlocked {
  ok: false;
  text: string;
  /** Set when the workspace already moved before the failure (a keep that committed). */
  workspace?: { commit: string | null };
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

interface KeepCheckSummaries {
  gateSummary: string;
  gateCriteriaIds: string[];
  gateHash: string;
  reviewSummary: string;
}

type KeepChecks =
  | { ok: true; summaries: KeepCheckSummaries }
  | { ok: false; blocked: RecordRunResultBlocked };

/**
 * Log one Run Result: validate, verify (Gate, then the optional reviewer),
 * settle the workspace, then journal and commit the state. This module owns the
 * order; callers own how the outcome is surfaced to the agent.
 */
export async function recordRunResult(params: LogRunParams, deps: RecordRunResultDeps): Promise<RecordRunResult> {
  const validationError = validateRunResultInput({
    state: deps.state,
    params,
    lastRunChecks: deps.lastRunChecks,
  });
  if (validationError) return { ok: false, text: validationError };

  const keepChecks = params.status === "keep" && deps.state.contract
    ? await evaluateKeepChecks(params, deps)
    : null;
  if (keepChecks && !keepChecks.ok) return keepChecks.blocked;

  const prepared = prepareRunResult(deps.state, params);
  let text = formatLogSummary({ state: prepared.state, applied: prepared.applied, params });
  if (keepChecks?.ok) {
    if (keepChecks.summaries.gateSummary) text = `${keepChecks.summaries.gateSummary}\n${text}`;
    if (keepChecks.summaries.reviewSummary) text = `${keepChecks.summaries.reviewSummary}\n${text}`;
  }

  // A kept Run Result must commit before the journal entry, because the entry
  // carries the commit hash. A rejected Run Result reverts only after the
  // journal and state are durable, so a failed write never destroys the
  // Attempt's evidence.
  let settlement: RunWorkspaceSettlement | null = null;
  if (params.status === "keep") {
    settlement = await settleWorkspace(params, prepared, deps, keepChecks?.ok ? keepChecks.summaries : null);
    if (!settlement.ok) {
      return {
        ok: false,
        text: `❌ Keep not logged: Git workspace settlement failed.${settlement.text}\nCandidate changes and the measured run are preserved. Fix Git and retry log_goal before another run.`,
      };
    }
    text += settlement.text;
    if (settlement.commit) prepared.applied.runResult.commit = settlement.commit;
  }

  const jsonlEntry = runResultJournalEntry(prepared.state.results.length, prepared.applied.runResult);
  const journalError = appendRunResultToJournal(deps.workDir, jsonlEntry);
  if (journalError) {
    return {
      ok: false,
      text: `${text}\n${journalError}${partialSettlementNote(settlement)}`,
      workspace: settlement ? { commit: settlement.commit } : undefined,
    };
  }

  commitResearchState(deps.state, prepared.state);

  if (params.status !== "keep") {
    settlement = await settleWorkspace(params, prepared, deps, null);
    text += settlement.text;
    if (settlement.attempt) {
      const attemptError = appendJournalEntry(deps.workDir, {
        type: "attempt",
        attempt: settlement.attempt,
      });
      if (attemptError) text += `\n${attemptError}`;
    }
  }

  const afterSteer = await deps.fireHook({
    event: "after",
    cwd: deps.workDir,
    run_entry: jsonlEntry,
    research: deps.buildResearchSnapshot(deps.state),
  });

  const limitReached = deps.state.runLimit !== null && prepared.applied.runCount >= deps.state.runLimit;
  let beforeSteer: string | null = null;
  if (!limitReached) {
    beforeSteer = await deps.fireHook({
      event: "before",
      cwd: deps.workDir,
      next_run: deps.state.results.length + 1,
      last_run: jsonlEntry,
      research: deps.buildResearchSnapshot(deps.state),
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

/**
 * A keep only lands when the Gate passes and the reviewer, if configured,
 * allows it. Both verdicts are journaled as they are reached, so a denial still
 * leaves its evidence behind.
 */
async function evaluateKeepChecks(
  params: LogRunParams,
  deps: RecordRunResultDeps,
): Promise<KeepChecks> {
  const contract = deps.state.contract;
  if (!contract) return { ok: true, summaries: emptySummaries() };

  const workspace = await checkResearchWorkspace(deps.pi, deps.workDir);
  if (workspace.error) {
    return fail(`❌ Gate could not read the workspace: ${workspace.error}`);
  }

  const recording = await recordGate({
    pi: deps.pi,
    workDir: deps.workDir,
    contract,
    state: deps.state,
    metric: params.metric,
    metrics: params.metrics,
    forceKeep: params.force_keep === true,
    changedPaths: workspace.userPaths,
  });
  if (!recording.recorded) return fail(recording.text);
  if (!gatePassed(recording)) return fail(formatGateFailure(recording.gate));

  const summaries: KeepCheckSummaries = {
    gateSummary: formatGateSummary(recording.gate),
    gateCriteriaIds: recording.gate.criteria
      .filter((verdict) => verdict.blocking && verdict.pass)
      .map((verdict) => verdict.criterionId),
    gateHash: recording.gate.contractHash,
    reviewSummary: "",
  };

  const reviewer = readReviewerConfig(deps.configDir ?? deps.workDir);
  if (!reviewer) return { ok: true, summaries };

  try {
    const reviewed = await recordReview({
      pi: deps.pi,
      workDir: deps.workDir,
      contract,
      state: deps.state,
      reviewer,
      changedPaths: workspace.userPaths,
    });
    if (!reviewed.recorded) return fail(reviewed.text);

    summaries.reviewSummary = reviewed.result.text;
    if (reviewed.result.deniedKeep) {
      return fail(
        `${reviewed.result.text}\n❌ Keep denied: the reviewer reproduced a blocking finding. Fix it and rerun, or log as discard with the finding in ASI.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (reviewer.blocking) {
      return fail(`❌ Reviewer failed while blocking is enabled: ${message}`);
    }
    summaries.reviewSummary = `⚠️ Reviewer failed (advisory): ${message}`;
  }

  return { ok: true, summaries };
}

function emptySummaries(): KeepCheckSummaries {
  return { gateSummary: "", gateCriteriaIds: [], gateHash: "", reviewSummary: "" };
}

function fail(text: string): KeepChecks {
  return { ok: false, blocked: { ok: false, text } };
}

function settleWorkspace(
  params: LogRunParams,
  prepared: PreparedRunResult,
  deps: RecordRunResultDeps,
  summaries: KeepCheckSummaries | null,
): Promise<RunWorkspaceSettlement> {
  return settleRunWorkspace({
    pi: deps.pi,
    workDir: deps.workDir,
    attemptsDir: activeResearch(deps.workDir).paths.attempts,
    runNumber: prepared.applied.runCount,
    description: params.description,
    metricName: deps.state.metricName,
    metric: params.metric,
    status: params.status,
    secondaryMetrics: prepared.applied.secondaryMetrics,
    criteriaIds: summaries?.gateCriteriaIds,
    gateHash: summaries?.gateHash || undefined,
  });
}

/** Tell the agent the truth when the workspace already moved but the record did not. */
function partialSettlementNote(settlement: RunWorkspaceSettlement | null): string {
  if (!settlement) return "";
  const landed = settlement.commit
    ? `The candidate is already committed as ${settlement.commit}.`
    : "The workspace may already hold the candidate changes.";
  return `\n⚠️ The Run Result was NOT recorded. ${landed} Re-run log_goal to journal it.`;
}

function prepareRunResult(state: ResearchState, params: LogRunParams): PreparedRunResult {
  const preparedState = cloneResearchState(state);
  return {
    state: preparedState,
    applied: applyRunResult(preparedState, params),
  };
}

export function finishRecordedRunResult(runtime: SessionRuntime, limitReached: boolean): void {
  runtime.activeRun = null;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  onResearchRunLogged(runtime.loop, limitReached);
}
