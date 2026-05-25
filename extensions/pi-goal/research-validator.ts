import * as fs from "node:fs";
import * as path from "node:path";

import { isGoalShCommand, parseMetricLines } from "./experiment-runner.ts";
import { hasResearchConfigHeader, reconstructResearchStateFromJournal } from "./research-journal.ts";
import {
  researchChecksPath,
  researchJournalPath,
  researchRulesPath,
  researchScriptPath,
} from "./paths.ts";

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
  const mdPath = researchRulesPath(workDir);
  const scriptPath = researchScriptPath(workDir);
  const jsonlPath = researchJournalPath(workDir);
  const checksPath = researchChecksPath(workDir);

  if (!fs.existsSync(mdPath)) {
    issues.push(error("missing_rules", `${mdPath} does not exist.`));
  }

  if (!fs.existsSync(scriptPath)) {
    issues.push(error("missing_script", `${scriptPath} does not exist.`));
  } else if (!fs.statSync(scriptPath).isFile()) {
    issues.push(error("invalid_script", `${scriptPath} is not a file.`));
  }

  let metricName: string | null = null;
  if (!fs.existsSync(jsonlPath)) {
    issues.push(error("missing_jsonl", `${jsonlPath} does not exist. Call init_goal.`));
  } else {
    const content = readFile(jsonlPath, issues);
    if (content !== null) {
      if (!hasResearchConfigHeader(content)) {
        issues.push(error("missing_config_header", `${jsonlPath} has no config header. Call init_goal.`));
      } else {
        const state = reconstructResearchStateFromJournal(content);
        metricName = state.metricName;
      }
    }
  }

  if (fs.existsSync(checksPath) && !fs.statSync(checksPath).isFile()) {
    issues.push(error("invalid_checks", `${checksPath} exists but is not a file.`));
  }

  let parsedMetrics: Record<string, number> | null = null;
  if (dryRun && fs.existsSync(scriptPath) && metricName) {
    if (!isGoalShCommand("bash goal.sh")) {
      issues.push(error("invalid_script_command", "Internal validator command was rejected by goal.sh guard."));
    } else {
      try {
        const result = await pi.exec("bash", [scriptPath], { cwd: workDir, timeout: timeoutMs });
        const output = `${result.stdout}\n${result.stderr}`;
        parsedMetrics = Object.fromEntries(parseMetricLines(output));
        if (result.killed) {
          issues.push(error("script_timeout", `${path.basename(scriptPath)} timed out during validation.`));
        } else if (result.code !== 0) {
          issues.push(error("script_failed", `${path.basename(scriptPath)} exited ${result.code} during validation.`));
        } else if (!(metricName in parsedMetrics)) {
          issues.push(error(
            "missing_primary_metric",
            `Expected dry-run output to contain METRIC ${metricName}=<number>. Parsed: ${Object.keys(parsedMetrics).join(", ") || "(none)"}.`,
          ));
        }
      } catch (validationError) {
        issues.push(error(
          "script_exec_failed",
          `Could not run ${path.basename(scriptPath)} during validation: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
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

function readFile(filePath: string, issues: ResearchValidationIssue[]): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (readError) {
    issues.push(error("read_failed", `Could not read ${filePath}: ${readError instanceof Error ? readError.message : String(readError)}`));
    return null;
  }
}

function error(code: string, message: string): ResearchValidationIssue {
  return { code, severity: "error", message };
}
