import * as path from "node:path";

import { isGoalShCommand, parseMetricLines } from "./experiment-runner.ts";
import type { ResearchFileContract } from "../persistence/research-files.ts";
import { shouldUseScriptCommandOnly } from "./research-command-policy.ts";
import {
  researchValidationError,
  type ResearchValidationIssue,
} from "../domain/research-validation.ts";

export interface ResearchDryRunExecAdapter {
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<{ code: number | null; killed?: boolean; stdout: string; stderr: string }>;
}

export interface ResearchDryRunValidationResult {
  issues: ResearchValidationIssue[];
  parsedMetrics: Record<string, number> | null;
}

export async function validateResearchDryRun(options: {
  workDir: string;
  pi: ResearchDryRunExecAdapter;
  contract: ResearchFileContract;
  metricName: string | null;
  dryRun: boolean;
  timeoutMs: number;
}): Promise<ResearchDryRunValidationResult> {
  const { workDir, pi, contract, metricName, dryRun, timeoutMs } = options;
  const issues: ResearchValidationIssue[] = [];
  let parsedMetrics: Record<string, number> | null = null;

  if (!dryRun || !shouldUseScriptCommandOnly(contract) || !metricName) {
    return { issues, parsedMetrics };
  }

  if (!isGoalShCommand("bash goal.sh")) {
    issues.push(researchValidationError("invalid_script_command", "Internal validator command was rejected by goal.sh guard."));
    return { issues, parsedMetrics };
  }

  try {
    const result = await pi.exec("bash", [contract.scriptPath], { cwd: workDir, timeout: timeoutMs });
    const output = `${result.stdout}\n${result.stderr}`;
    parsedMetrics = Object.fromEntries(parseMetricLines(output));
    if (result.killed) {
      issues.push(researchValidationError("script_timeout", `${path.basename(contract.scriptPath)} timed out during validation.`));
    } else if (result.code !== 0) {
      issues.push(researchValidationError("script_failed", `${path.basename(contract.scriptPath)} exited ${result.code} during validation.`));
    } else if (!(metricName in parsedMetrics)) {
      issues.push(researchValidationError(
        "missing_primary_metric",
        `Expected dry-run output to contain METRIC ${metricName}=<number>. Parsed: ${Object.keys(parsedMetrics).join(", ") || "(none)"}.`,
      ));
    }
  } catch (validationError) {
    issues.push(researchValidationError(
      "script_exec_failed",
      `Could not run ${path.basename(contract.scriptPath)} during validation: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
    ));
  }

  return { issues, parsedMetrics };
}
