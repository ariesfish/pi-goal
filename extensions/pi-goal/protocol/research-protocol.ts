import {
  activateResearch,
  cancelPendingResearchPhaseResume,
  composeResearchPhaseCompactionResumeMessage,
  composeResearchPhaseResumeMessage,
  deactivateResearch,
  detectPhaseFromFiles,
  enterResearchLoopingFromFiles,
  enterResearchNeedsInitFromFiles,
  hasPendingResearchPhaseResume,
  hasReachedResearchAutoResumeLimit,
  markResearchAutoResumeSent,
  shouldResearchAutoResumeAfterCompact,
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

export type PendingResearchResumeDecision =
  | { action: "deliver"; message: string }
  | { action: "cancel" }
  | { action: "limit_reached" }
  | { action: "wait" };

export interface ActivationStartDecision {
  kickoff: string;
  notification: string;
}

export function syncResearchPhaseFromResearchFiles(
  loop: ResearchPhaseState,
  contract: ResearchFileContract,
): void {
  if (contract.hasConfigHeader) {
    enterResearchLoopingFromFiles(loop);
    return;
  }

  const phase = detectPhaseFromFiles({
    hasRules: contract.hasRules,
    hasConfig: contract.hasConfigHeader,
    hasBenchmarkScript: contract.hasBenchmarkScript,
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

export function shouldResumeResearchAfterTurn(runtime: SessionRuntime, options: ResearchProtocolOptions): boolean {
  return shouldResearchAutoResumeAfterTurn(runtime.loop, options);
}

export function shouldResumeResearchAfterCompact(runtime: SessionRuntime): boolean {
  return shouldResearchAutoResumeAfterCompact(runtime.loop);
}

export function composeResearchResumeMessage(runtime: SessionRuntime, options: ResearchProtocolOptions): string {
  return composeResearchPhaseResumeMessage(runtime.loop, options);
}

export function composeResearchCompactionResumeMessage(options: ResearchProtocolOptions): string {
  return composeResearchPhaseCompactionResumeMessage(options);
}

export function hasPendingResearchResume(runtime: SessionRuntime): boolean {
  return hasPendingResearchPhaseResume(runtime.loop);
}

export function cancelResearchResume(runtime: SessionRuntime): void {
  cancelPendingResearchPhaseResume(runtime.loop);
}

export function decidePendingResearchResume(
  runtime: SessionRuntime,
  options: ResearchProtocolOptions,
  isAgentSettled: boolean,
): PendingResearchResumeDecision {
  const message = runtime.loop.pendingResumeMessage;
  if (!message) return { action: "wait" };
  if (!runtime.loop.mode) return { action: "cancel" };
  if (!isAgentSettled) return { action: "wait" };
  if (hasReachedResearchAutoResumeLimit(runtime.loop, options)) return { action: "limit_reached" };
  return { action: "deliver", message };
}

export function onResearchResumeDelivered(runtime: SessionRuntime): void {
  cancelResearchResume(runtime);
  markResearchAutoResumeSent(runtime.loop);
}

export function shouldNotifyResearchResumeLimit(runtime: SessionRuntime, options: ResearchProtocolOptions): boolean {
  return hasReachedResearchAutoResumeLimit(runtime.loop, options);
}
