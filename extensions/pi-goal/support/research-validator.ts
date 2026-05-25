import { validateResearchDryRun, type ResearchDryRunExecAdapter } from "../execution/research-dry-run.ts";
import { validateResearchFiles } from "../persistence/research-file-validation.ts";
import {
  researchValidationResult,
  type ResearchValidationIssue,
  type ResearchValidationResult,
} from "../domain/research-validation.ts";

export type ValidatorExecAdapter = ResearchDryRunExecAdapter;
export type { ResearchValidationIssue, ResearchValidationResult };

export async function validateResearch(options: {
  workDir: string;
  pi: ValidatorExecAdapter;
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<ResearchValidationResult> {
  const { workDir, pi, dryRun = true, timeoutMs = 60_000 } = options;
  const fileValidation = validateResearchFiles(workDir);
  const metricName = fileValidation.contract.metricName;
  const dryRunValidation = await validateResearchDryRun({
    workDir,
    pi,
    contract: fileValidation.contract,
    metricName,
    dryRun,
    timeoutMs,
  });

  return researchValidationResult({
    workDir,
    metricName,
    issues: [...fileValidation.issues, ...dryRunValidation.issues],
    parsedMetrics: dryRunValidation.parsedMetrics,
  });
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
