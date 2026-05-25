import type { ActivationSnapshot, PromptSnapshot } from "./research-phase.ts";
import type { ResearchFileContract } from "../persistence/research-files.ts";

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
