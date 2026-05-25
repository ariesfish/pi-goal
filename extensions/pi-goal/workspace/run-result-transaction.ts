import {
  commitKeptRunResult,
  restoreRejectedRunResult,
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
}

export interface RunWorkspaceTransactionResult {
  text: string;
  commit: string | null;
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
  });
}

export async function restoreRejectedRunResultTransaction(
  options: Pick<RunWorkspaceTransactionOptions, "pi" | "workDir" | "status">,
): Promise<string> {
  if (options.status === "keep") return "";
  return restoreRejectedRunResult({ pi: options.pi, workDir: options.workDir, status: options.status });
}
