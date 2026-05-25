import {
  readResearchFileContract,
  type ResearchFileContract,
} from "./research-files.ts";
import {
  researchValidationError,
  type ResearchValidationIssue,
} from "../domain/research-validation.ts";

export interface ResearchFileValidationResult {
  contract: ResearchFileContract;
  issues: ResearchValidationIssue[];
}

export function validateResearchFiles(workDir: string): ResearchFileValidationResult {
  const contract = readResearchFileContract(workDir);
  const issues: ResearchValidationIssue[] = [];

  if (!contract.hasRules) {
    issues.push(researchValidationError("missing_rules", `${contract.rulesPath} does not exist.`));
  } else if (contract.invalidRules) {
    issues.push(researchValidationError("invalid_rules", contract.invalidRules));
  }

  if (!contract.hasBenchmarkScript) {
    issues.push(researchValidationError("missing_script", `${contract.scriptPath} does not exist.`));
  } else if (contract.invalidBenchmarkScript) {
    issues.push(researchValidationError("invalid_script", contract.invalidBenchmarkScript));
  }

  if (!contract.hasJournal) {
    issues.push(researchValidationError("missing_jsonl", `${contract.journalPath} does not exist. Call init_goal.`));
  } else if (contract.journalReadError) {
    issues.push(researchValidationError("read_failed", `Could not read ${contract.journalPath}: ${contract.journalReadError}`));
  } else if (!contract.hasConfigHeader) {
    issues.push(researchValidationError("missing_config_header", `${contract.journalPath} has no config header. Call init_goal.`));
  }

  if (contract.invalidChecks) {
    issues.push(researchValidationError("invalid_checks", contract.invalidChecks));
  }

  return { contract, issues };
}
