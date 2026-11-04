import type { ResearchProtocolOptions } from "./research-phase.ts";
import {
  hasReachedResearchAutoResumeLimit,
  shouldResearchAutoResumeAfterTurn,
} from "./research-phase.ts";
import {
  failureStopReason,
  noProgressStopReason,
} from "./research-guards.ts";
import type { SessionRuntime } from "../support/runtime.ts";

export type BoundaryDecision =
  | { action: "none" }
  | { action: "continue"; message: string }
  | { action: "stop"; reason: string };

export interface BoundaryDecisionInput {
  runtime: SessionRuntime;
  options: ResearchProtocolOptions;
  canContinue: boolean;
  outcome: "completed" | "aborted" | "error";
  composeMessage(): string;
}

export function decideBoundaryContinuation(input: BoundaryDecisionInput): BoundaryDecision {
  const { runtime, options } = input;
  if (!runtime.loop.mode) return { action: "none" };
  if (input.outcome !== "completed" || !input.canContinue) return { action: "none" };

  if (hasReachedResearchAutoResumeLimit(runtime.loop, options)) {
    return {
      action: "stop",
      reason: `Research auto-resume limit reached (${options.maxAutoResumeTurns} turns).`,
    };
  }

  const failureReason = failureStopReason(runtime.state.results);
  if (failureReason) return { action: "stop", reason: failureReason };

  if (runtime.loop.phase === "sealed") {
    const progressReason = noProgressStopReason(
      runtime.state.results,
      runtime.state.currentExperimentIndex,
    );
    if (progressReason) return { action: "stop", reason: progressReason };
  }

  if (!shouldResearchAutoResumeAfterTurn(runtime.loop, options)) {
    return { action: "none" };
  }

  return { action: "continue", message: input.composeMessage() };
}
