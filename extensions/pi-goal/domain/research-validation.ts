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

export function researchValidationResult(options: {
  workDir: string;
  metricName: string | null;
  issues: ResearchValidationIssue[];
  parsedMetrics: Record<string, number> | null;
}): ResearchValidationResult {
  return {
    ...options,
    ok: !options.issues.some((issue) => issue.severity === "error"),
  };
}

export function researchValidationError(code: string, message: string): ResearchValidationIssue {
  return { code, severity: "error", message };
}
