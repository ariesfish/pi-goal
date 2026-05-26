import * as fs from "node:fs";

import { activeResearch } from "./research-directory.ts";
import {
  hasResearchConfigHeader,
  parseResearchJournalModel,
} from "./research-journal-codec.ts";
import {
  researchValidationError,
  type ResearchValidationIssue,
} from "../domain/research-validation.ts";

export interface ResearchFileContract {
  workDir: string;
  rulesPath: string;
  scriptPath: string;
  checksPath: string;
  ideasPath: string;
  journalPath: string;
  hasRules: boolean;
  hasBenchmarkScript: boolean;
  hasChecks: boolean;
  hasIdeas: boolean;
  hasJournal: boolean;
  hasConfigHeader: boolean;
  metricName: string | null;
  invalidRules: string | null;
  invalidBenchmarkScript: string | null;
  invalidChecks: string | null;
  journalReadError: string | null;
}

export interface ResearchFileValidationResult {
  contract: ResearchFileContract;
  issues: ResearchValidationIssue[];
}

export function readResearchFileContract(workDir: string): ResearchFileContract {
  const paths = activeResearch(workDir).paths;
  const rulesPath = paths.rules;
  const scriptPath = paths.script;
  const checksPath = paths.checks;
  const ideasPath = paths.ideas;
  const journalPath = paths.journal;

  const hasRules = fs.existsSync(rulesPath);
  const hasBenchmarkScript = fs.existsSync(scriptPath);
  const hasChecks = fs.existsSync(checksPath);
  const hasIdeas = fs.existsSync(ideasPath);
  const hasJournal = fs.existsSync(journalPath);

  let hasConfigHeader = false;
  let metricName: string | null = null;
  let journalReadError: string | null = null;

  if (hasJournal) {
    try {
      const content = fs.readFileSync(journalPath, "utf-8");
      hasConfigHeader = hasResearchConfigHeader(content);
      if (hasConfigHeader) {
        metricName = parseResearchJournalModel(content).metricName;
      }
    } catch (error) {
      journalReadError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    workDir,
    rulesPath,
    scriptPath,
    checksPath,
    ideasPath,
    journalPath,
    hasRules,
    hasBenchmarkScript,
    hasChecks,
    hasIdeas,
    hasJournal,
    hasConfigHeader,
    metricName,
    invalidRules: hasRules && !isFile(rulesPath) ? `${rulesPath} exists but is not a file.` : null,
    invalidBenchmarkScript: hasBenchmarkScript && !isFile(scriptPath) ? `${scriptPath} exists but is not a file.` : null,
    invalidChecks: hasChecks && !isFile(checksPath) ? `${checksPath} exists but is not a file.` : null,
    journalReadError,
  };
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

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
