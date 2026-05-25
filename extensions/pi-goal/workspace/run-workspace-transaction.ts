import {
  commitKeptExperiment,
  revertRejectedExperiment,
  type WorkspaceExecAdapter,
} from "./experiment-workspace.ts";

export interface RunWorkspaceTransactionOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  description: string;
  metricName: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  secondaryMetrics: Record<string, number>;
}

export interface RunWorkspaceTransactionResult {
  text: string;
  commit: string | null;
}

export async function applyKeptRunTransaction(
  options: RunWorkspaceTransactionOptions,
): Promise<RunWorkspaceTransactionResult> {
  if (options.status !== "keep") return { text: "", commit: null };
  return commitKeptExperiment({
    pi: options.pi,
    workDir: options.workDir,
    description: options.description,
    metricName: options.metricName,
    metric: options.metric,
    status: options.status,
    secondaryMetrics: options.secondaryMetrics,
  });
}

export async function restoreRejectedRunTransaction(
  options: Pick<RunWorkspaceTransactionOptions, "pi" | "workDir" | "status">,
): Promise<string> {
  if (options.status === "keep") return "";
  return revertRejectedExperiment({ pi: options.pi, workDir: options.workDir, status: options.status });
}
