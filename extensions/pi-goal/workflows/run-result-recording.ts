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
  appendRunResultToJournal,
  runResultJournalEntry,
} from "../persistence/research-journal.ts";

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

  const prepared = prepareRunResult(state, params);
  let text = formatLogSummary({ state: prepared.state, applied: prepared.applied, params });

  const keepResult = await applyKeptRunResultTransaction({
    pi: deps.pi,
    workDir: deps.workDir,
    description: params.description,
    metricName: state.metricName,
    metric: params.metric,
    status: params.status,
    secondaryMetrics: prepared.applied.secondaryMetrics,
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
