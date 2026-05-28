import { createResearchState, cloneResearchState, computeConfidence, type ResearchState } from "../domain/research-state.ts";
import {
  resetResearchPhaseForAgentStart,
  resetResearchResumeCounters,
  type ResearchPhaseState,
} from "../protocol/research-phase.ts";
import { syncResearchPhaseFromResearchFiles } from "../protocol/research-protocol.ts";
import type { LogDetails, SessionRuntime } from "./runtime.ts";
import { readRunLimit } from "../persistence/goal-config.ts";
import { readResearchFileContract, type ResearchFileContract } from "../persistence/research-files.ts";
import { hydrateResearchStateFromJournalFile } from "../persistence/research-journal.ts";

export interface SessionBranchMessageEntry {
  type: string;
  message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
  };
}

export interface ActiveResearchRuntimeRestoreResult {
  state: ResearchState;
  fileContract: ResearchFileContract;
  loadedFromJournal: boolean;
}

export function resetRuntimeForActiveResearchRestore(runtime: SessionRuntime): void {
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.activeRun = null;
  resetResearchPhaseForAgentStart(runtime.loop);
  resetResearchResumeCounters(runtime.loop);
  runtime.state = createResearchState();
}

export function restoreActiveResearchRuntime(options: {
  runtime: SessionRuntime;
  workDir: string;
  ctxCwd: string;
  sessionBranch: Iterable<SessionBranchMessageEntry>;
}): ActiveResearchRuntimeRestoreResult {
  const { runtime, workDir, ctxCwd, sessionBranch } = options;
  resetRuntimeForActiveResearchRestore(runtime);

  let state = runtime.state;
  const loadedFromJournal = hydrateRuntimeStateFromJournal(state, workDir);
  if (!loadedFromJournal) {
    state = hydrateRuntimeStateFromSessionBranch(runtime, sessionBranch);
  }

  state.runLimit = readRunLimit(ctxCwd);
  const fileContract = readResearchFileContract(workDir);
  syncResearchPhaseFromResearchFiles(runtime.loop, fileContract);

  return { state, fileContract, loadedFromJournal };
}

function hydrateRuntimeStateFromJournal(state: ResearchState, workDir: string): boolean {
  try {
    return hydrateResearchStateFromJournalFile(state, workDir);
  } catch {
    return false;
  }
}

function hydrateRuntimeStateFromSessionBranch(
  runtime: SessionRuntime,
  sessionBranch: Iterable<SessionBranchMessageEntry>,
): ResearchState {
  for (const entry of sessionBranch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "toolResult" || msg.toolName !== "log_goal") continue;
    const details = msg.details as LogDetails | undefined;
    if (!details?.state) continue;

    runtime.state = normalizeRestoredState(cloneResearchState(details.state));
  }
  return runtime.state;
}

function normalizeRestoredState(state: ResearchState): ResearchState {
  if (!state.secondaryMetrics) state.secondaryMetrics = [];
  if (state.metricUnit === "s" && state.metricName === "metric") {
    state.metricUnit = "";
  }
  for (const result of state.results) {
    if (!result.metrics) result.metrics = {};
    if (result.confidence === undefined) result.confidence = null;
  }
  if (state.confidence === undefined) {
    state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
  }
  return state;
}
