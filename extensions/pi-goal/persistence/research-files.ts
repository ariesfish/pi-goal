import * as fs from "node:fs";

import { hasResearchConfigHeader, reconstructResearchStateFromJournal } from "./research-journal.ts";
import {
  researchChecksPath,
  researchIdeasPath,
  researchJournalPath,
  researchRulesPath,
  researchScriptPath,
} from "./research-paths.ts";
import type { ActivationSnapshot, PromptSnapshot } from "../protocol/research-phase.ts";

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

export function readResearchFileContract(workDir: string): ResearchFileContract {
  const rulesPath = researchRulesPath(workDir);
  const scriptPath = researchScriptPath(workDir);
  const checksPath = researchChecksPath(workDir);
  const ideasPath = researchIdeasPath(workDir);
  const journalPath = researchJournalPath(workDir);

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
        metricName = reconstructResearchStateFromJournal(content).metricName;
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

export function activationSnapshotFor(contract: ResearchFileContract, userGoal: string): ActivationSnapshot {
  return {
    userGoal,
    hasRules: contract.hasRules,
    hasConfig: contract.hasConfigHeader,
    hasBenchmarkScript: contract.hasBenchmarkScript,
  };
}

export function promptSnapshotFor(contract: ResearchFileContract): PromptSnapshot {
  return {
    hasRules: contract.hasRules,
    hasConfig: contract.hasConfigHeader,
    hasBenchmarkScript: contract.hasBenchmarkScript,
    hasIdeas: contract.hasIdeas,
    hasChecks: contract.hasChecks,
    mdPath: contract.rulesPath,
    ideasPath: contract.ideasPath,
    checksPath: contract.checksPath,
  };
}

export function shouldUseScriptCommandOnly(contract: ResearchFileContract): boolean {
  return contract.hasBenchmarkScript && !contract.invalidBenchmarkScript;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
