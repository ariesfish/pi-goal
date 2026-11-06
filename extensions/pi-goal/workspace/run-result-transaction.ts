import type { Attempt } from "../domain/goal-contract.ts";
import {
  commitKeptRunResult,
  restoreRejectedRunResult,
  type WorkspaceExecAdapter,
} from "./research-workspace.ts";

export type SettledRunStatus = "keep" | "discard" | "crash" | "checks_failed";

export interface RunWorkspaceSettlementOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  /** Where reverted-attempt patches are written. */
  attemptsDir: string;
  runNumber: number;
  description: string;
  metricName: string;
  metric: number;
  status: SettledRunStatus;
  secondaryMetrics: Record<string, number>;
  criteriaIds?: string[];
  gateHash?: string;
}

export interface RunWorkspaceSettlement {
  text: string;
  /** Set when a kept Run Result landed as a commit. */
  commit: string | null;
  /** Set when a rejected Run Result was reverted and its diff kept. */
  attempt: Attempt | null;
}

/**
 * The workspace half of logging a Run Result: a kept run commits the
 * candidate, a rejected run reverts to the checkpoint and keeps its diff as an
 * Attempt patch. This is the only place that decides which of the two happens.
 */
export async function settleRunWorkspace(
  options: RunWorkspaceSettlementOptions,
): Promise<RunWorkspaceSettlement> {
  if (options.status === "keep") {
    const kept = await commitKeptRunResult({
      pi: options.pi,
      workDir: options.workDir,
      description: options.description,
      metricName: options.metricName,
      metric: options.metric,
      status: options.status,
      secondaryMetrics: options.secondaryMetrics,
      criteriaIds: options.criteriaIds,
      gateHash: options.gateHash,
    });
    return { text: kept.text, commit: kept.commit, attempt: null };
  }

  const rejected = await restoreRejectedRunResult({
    pi: options.pi,
    workDir: options.workDir,
    status: options.status,
    runNumber: options.runNumber,
    description: options.description,
    attemptsDir: options.attemptsDir,
  });
  return { text: rejected.text, commit: null, attempt: rejected.attempt };
}
