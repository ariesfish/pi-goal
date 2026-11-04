import {
  activateResearch,
  composeResearchPhaseResumeMessage,
  deactivateResearch,
  detectPhaseFromFiles,
  enterResearchSealedFromFiles,
  enterResearchNeedsInitFromFiles,
  shouldResearchAutoResumeAfterTurn,
  researchPhaseSystemPromptFor,
  type ResearchProtocolOptions,
  type ResearchPhaseState,
} from "./research-phase.ts";
import type { ResearchFileContract } from "../persistence/research-files.ts";
import {
  activationSnapshotFor,
  promptSnapshotFor,
} from "./research-file-snapshots.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { legacyMetricContract } from "../domain/goal-contract.ts";

export interface ActivationStartDecision {
  kickoff: string;
  notification: string;
}

export function syncResearchPhaseFromResearchFiles(
  loop: ResearchPhaseState,
  contract: ResearchFileContract,
  state: ResearchState,
): void {
  if (contract.hasContract || contract.hasConfigHeader) {
    if (state.contract === null && contract.hasConfigHeader) {
      state.contract = legacyMetricContract({
        metricName: state.metricName || contract.metricName || "metric",
        direction: state.bestDirection,
      });
    }
    enterResearchSealedFromFiles(loop, { hasBaseline: contract.hasRuns });
    return;
  }

  const phase = detectPhaseFromFiles({
    hasRules: contract.hasRules,
    hasConfig: contract.hasConfigHeader,
    hasBenchmarkScript: contract.hasBenchmarkScript,
    hasContract: contract.hasContract,
  });
  if (phase === "needs_init") {
    enterResearchNeedsInitFromFiles(loop);
  } else {
    deactivateResearch(loop);
  }
}

export function ensureNeedsInitFromResearchFiles(
  loop: ResearchPhaseState,
  contract: ResearchFileContract,
): void {
  if (!loop.mode && contract.hasRules && contract.hasBenchmarkScript && !contract.hasConfigHeader) {
    enterResearchNeedsInitFromFiles(loop);
  }
}

export function composeResearchSystemPrompt(
  loop: ResearchPhaseState,
  contract: ResearchFileContract,
  options: ResearchProtocolOptions,
): string {
  ensureNeedsInitFromResearchFiles(loop, contract);
  return researchPhaseSystemPromptFor(loop, promptSnapshotFor(contract), options);
}

export function startResearchActivation(
  loop: ResearchPhaseState,
  contract: ResearchFileContract,
  userGoal: string,
  options: ResearchProtocolOptions,
): ActivationStartDecision {
  const kickoff = activateResearch(loop, activationSnapshotFor(contract, userGoal), options);
  return {
    kickoff,
    notification: contract.hasRules
      ? "Research mode ON — rules loaded from goal.md"
      : "Research mode ON — no goal.md found, setting up",
  };
}

export function composeResearchResumeMessage(runtime: SessionRuntime, options: ResearchProtocolOptions): string {
  return composeResearchPhaseResumeMessage(runtime.loop, options);
}

