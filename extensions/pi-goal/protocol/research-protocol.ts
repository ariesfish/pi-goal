import {
  activateResearch,
  composeResearchPhaseResumeMessage,
  deactivateResearch,
  detectPreContractPhase,
  enterResearchSealed,
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
    enterResearchSealed(loop, { hasBaseline: contract.hasRuns });
    return;
  }

  const phase = detectPreContractPhase({
    hasRules: contract.hasRules,
    hasBenchmarkScript: contract.hasBenchmarkScript,
  });
  if (phase === "needs_init") {
    enterResearchNeedsInitFromFiles(loop);
  } else {
    deactivateResearch(loop);
  }
}

/**
 * Research files can appear mid-session (the agent writes goal.md and goal.sh
 * during a turn), so every turn re-checks for them before composing the prompt.
 * Kept separate from `composeResearchSystemPrompt` so composing stays a read.
 */
export function syncResearchPhaseForTurn(
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

