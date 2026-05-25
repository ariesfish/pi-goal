import * as path from "node:path";

import { isGoalShCommand, parseMetricLines } from "../execution/experiment-runner.ts";
import { readResearchFileContract, shouldUseScriptCommandOnly } from "../persistence/research-files.ts";

export interface ValidatorExecAdapter {
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<{ code: number | null; killed?: boolean; stdout: string; stderr: string }>;
}

export interface ResearchValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface ResearchValidationResult {
  ok: boolean;
  workDir: string;
  metricName: string | null;
  issues: ResearchValidationIssue[];
  parsedMetrics: Record<string, number> | null;
}

export async function validateResearch(options: {
  workDir: string;
  pi: ValidatorExecAdapter;
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<ResearchValidationResult> {
  const { workDir, pi, dryRun = true, timeoutMs = 60_000 } = options;
  const issues: ResearchValidationIssue[] = [];
  const contract = readResearchFileContract(workDir);

  if (!contract.hasRules) {
    issues.push(error("missing_rules", `${contract.rulesPath} does not exist.`));
  } else if (contract.invalidRules) {
    issues.push(error("invalid_rules", contract.invalidRules));
  }

  if (!contract.hasBenchmarkScript) {
    issues.push(error("missing_script", `${contract.scriptPath} does not exist.`));
  } else if (contract.invalidBenchmarkScript) {
    issues.push(error("invalid_script", contract.invalidBenchmarkScript));
  }

  if (!contract.hasJournal) {
    issues.push(error("missing_jsonl", `${contract.journalPath} does not exist. Call init_goal.`));
  } else if (contract.journalReadError) {
    issues.push(error("read_failed", `Could not read ${contract.journalPath}: ${contract.journalReadError}`));
  } else if (!contract.hasConfigHeader) {
    issues.push(error("missing_config_header", `${contract.journalPath} has no config header. Call init_goal.`));
  }

  if (contract.invalidChecks) {
    issues.push(error("invalid_checks", contract.invalidChecks));
  }

  const metricName = contract.metricName;
  let parsedMetrics: Record<string, number> | null = null;
  if (dryRun && shouldUseScriptCommandOnly(contract) && metricName) {
    if (!isGoalShCommand("bash goal.sh")) {
      issues.push(error("invalid_script_command", "Internal validator command was rejected by goal.sh guard."));
    } else {
      try {
        const result = await pi.exec("bash", [contract.scriptPath], { cwd: workDir, timeout: timeoutMs });
        const output = `${result.stdout}\n${result.stderr}`;
        parsedMetrics = Object.fromEntries(parseMetricLines(output));
        if (result.killed) {
          issues.push(error("script_timeout", `${path.basename(contract.scriptPath)} timed out during validation.`));
        } else if (result.code !== 0) {
          issues.push(error("script_failed", `${path.basename(contract.scriptPath)} exited ${result.code} during validation.`));
        } else if (!(metricName in parsedMetrics)) {
          issues.push(error(
            "missing_primary_metric",
            `Expected dry-run output to contain METRIC ${metricName}=<number>. Parsed: ${Object.keys(parsedMetrics).join(", ") || "(none)"}.`,
          ));
        }
      } catch (validationError) {
        issues.push(error(
          "script_exec_failed",
          `Could not run ${path.basename(contract.scriptPath)} during validation: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
        ));
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    workDir,
    metricName,
    issues,
    parsedMetrics,
  };
}

export function formatResearchValidationResult(result: ResearchValidationResult): string {
  const status = result.ok ? "✅ Research is valid" : "❌ Research is invalid";
  const lines = [status, `Working directory: ${result.workDir}`];
  if (result.metricName) lines.push(`Primary metric: ${result.metricName}`);
  if (result.parsedMetrics && Object.keys(result.parsedMetrics).length > 0) {
    lines.push(`Parsed metrics: ${Object.entries(result.parsedMetrics).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  if (result.issues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of result.issues) {
      lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function error(code: string, message: string): ResearchValidationIssue {
  return { code, severity: "error", message };
}
