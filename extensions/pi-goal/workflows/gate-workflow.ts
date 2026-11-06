import type { GateResult, GoalContract } from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { gateJournalEntry, runGate } from "../execution/gate-runner.ts";
import { appendJournalEntry } from "../persistence/research-journal.ts";
import {
  checkResearchWorkspace,
  type WorkspaceExecAdapter,
} from "../workspace/research-workspace.ts";

export interface RecordGateOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  metric: number;
  metrics?: Record<string, number>;
  forceKeep?: boolean;
  /** Reuse a workspace read the caller already made; otherwise one is taken. */
  changedPaths?: string[];
}

export type GateRecording =
  | { recorded: true; gate: GateResult }
  | { recorded: false; text: string };

/**
 * Evaluate the Gate, append its verdict to the Research Journal, and keep it
 * on the in-memory state. A failing verdict is still a recorded Gate: callers
 * decide whether a fail blocks, so this seam only fails on workspace or
 * journal errors.
 */
export async function recordGate(options: RecordGateOptions): Promise<GateRecording> {
  let changedPaths = options.changedPaths;
  if (!changedPaths) {
    const workspace = await checkResearchWorkspace(options.pi, options.workDir);
    if (workspace.error) {
      return { recorded: false, text: `❌ Gate could not read the workspace: ${workspace.error}` };
    }
    changedPaths = workspace.userPaths;
  }

  const gate = await runGate({
    pi: options.pi,
    workDir: options.workDir,
    contract: options.contract,
    state: options.state,
    metric: options.metric,
    metrics: options.metrics,
    changedPaths,
    forceKeep: options.forceKeep,
  });

  const journalError = appendJournalEntry(options.workDir, gateJournalEntry(gate));
  if (journalError) return { recorded: false, text: journalError };

  options.state.gates.push(gate);
  return { recorded: true, gate };
}

export function gatePassed(recording: { gate: GateResult }): boolean {
  return recording.gate.verdict === "pass";
}
