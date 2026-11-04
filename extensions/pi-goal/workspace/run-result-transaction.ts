import {
  commitKeptRunResult,
  restoreRejectedRunResult,
  type RestoreRejectedRunResult,
  type WorkspaceExecAdapter,
} from "./research-workspace.ts";

export interface RunWorkspaceTransactionOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  description: string;
  metricName: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  secondaryMetrics: Record<string, number>;
  criteriaIds?: string[];
  gateHash?: string;
}

export interface RunWorkspaceTransactionResult {
  text: string;
  commit: string | null;
}

export interface RestoreRejectedRunOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  status: "discard" | "crash" | "checks_failed";
  runNumber: number;
  description: string;
  attemptsDir: string;
}

export async function applyKeptRunResultTransaction(
  options: RunWorkspaceTransactionOptions,
): Promise<RunWorkspaceTransactionResult> {
  if (options.status !== "keep") return { text: "", commit: null };
  return commitKeptRunResult({
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
}

export async function restoreRejectedRunResultTransaction(
  options: RestoreRejectedRunOptions,
): Promise<RestoreRejectedRunResult> {
  // Keeps are committed, never reverted; the status type omits keep, but the
  // workflow passes every status through this seam.
  if ((options.status as string) === "keep") return { text: "", attempt: null };
  return restoreRejectedRunResult(options);
}
