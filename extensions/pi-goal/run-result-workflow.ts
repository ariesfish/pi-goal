import type { HookPayload, ResearchSnapshot } from "./execution/hooks.ts";
import {
  applyRunResult,
  validateRunResultInput,
  type LogRunParams,
} from "./domain/run-result.ts";
import { runResultJournalEntry, appendRunResultToJournal } from "./persistence/run-result-store.ts";
import { formatLogSummary } from "./ui/log-result-renderer.ts";
import { applyKeptRunTransaction, restoreRejectedRunTransaction } from "./workspace/run-workspace-transaction.ts";
import type { WorkspaceExecAdapter } from "./workspace/experiment-workspace.ts";
import { isBetter, type ResearchState, type RunResult } from "./domain/research-state.ts";

export type { LogRunParams } from "./domain/run-result.ts";

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

  const keepResult = await applyKeptRunTransaction({
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

  text += await restoreRejectedRunTransaction({
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

export { isBetter };
