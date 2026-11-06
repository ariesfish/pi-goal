import {
  allDirectionsClosed,
  contractReadyToSeal,
  directionsReadyForProbing,
  type Direction,
  type GoalContract,
} from "../domain/goal-contract.ts";
import {
  activationMessage,
  composeResearchPhaseResumeMessage,
  researchAwaitingLogBlockMessage,
  researchPhaseSystemPromptFor,
} from "./research-phase-prompts.ts";

export type ResearchPhase =
  | "inactive"
  | "framing"
  | "probing"
  | "converging"
  | "sealed"
  | "needs_init"
  | "needs_baseline"
  | "awaiting_log"
  | "limit_reached";

export interface LastRunSummary {
  command: string;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  checksPass: boolean | null;
  checksTimedOut: boolean;
  parsedPrimary: number | null;
  parsedMetrics: Record<string, number> | null;
  metricName: string;
  metricUnit: string;
}

export interface ResearchPhaseState {
  mode: boolean;
  phase: ResearchPhase;
  activationPrompt: string | null;
  activationTurns: number;
  autoResumeTurns: number;
  runsSinceAgentStart: number;
  lastRun: LastRunSummary | null;
}

export interface ResearchProtocolOptions {
  maxAutoResumeTurns: number;
  maxActivationTurns: number;
  benchmarkGuardrail: string;
}

export interface ActivationSnapshot {
  userGoal: string;
  hasRules: boolean;
  hasConfig: boolean;
  hasBenchmarkScript: boolean;
  hasContract?: boolean;
}

export interface PromptSnapshot {
  hasRules: boolean;
  hasConfig: boolean;
  hasBenchmarkScript: boolean;
  hasIdeas: boolean;
  hasChecks: boolean;
  mdPath: string;
  ideasPath: string;
  checksPath: string;
}

export interface PhaseTransition {
  ok: boolean;
  phase: ResearchPhase;
  reason?: string;
}

const SETUP_PHASES: readonly ResearchPhase[] = [
  "framing",
  "probing",
  "converging",
  "needs_init",
  "needs_baseline",
];

export function createResearchPhaseState(): ResearchPhaseState {
  return {
    mode: false,
    phase: "inactive",
    activationPrompt: null,
    activationTurns: 0,
    autoResumeTurns: 0,
    runsSinceAgentStart: 0,
    lastRun: null,
  };
}

export function resetResearchPhaseForAgentStart(state: ResearchPhaseState): void {
  state.runsSinceAgentStart = 0;
}

export function resetResearchResumeCounters(state: ResearchPhaseState): void {
  state.autoResumeTurns = 0;
  state.activationTurns = 0;
}

export function enterResearchNeedsInitFromFiles(state: ResearchPhaseState): void {
  state.mode = true;
  state.phase = "needs_init";
  state.activationPrompt = null;
  state.lastRun = null;
}

export function enterResearchSealed(
  state: ResearchPhaseState,
  options: { hasBaseline?: boolean },
): void {
  state.mode = true;
  state.phase = options.hasBaseline === false ? "needs_baseline" : "sealed";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.lastRun = null;
}

export function beginResearchFraming(state: ResearchPhaseState): void {
  state.mode = true;
  state.phase = "framing";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.lastRun = null;
}

export function enterResearchProbing(
  state: ResearchPhaseState,
  directions: Direction[],
): PhaseTransition {
  const ready = directionsReadyForProbing(directions);
  if (!ready.ok) return { ok: false, phase: state.phase, reason: ready.reason };
  state.mode = true;
  state.phase = "probing";
  state.activationPrompt = null;
  state.lastRun = null;
  return { ok: true, phase: state.phase };
}

export function enterResearchConverging(
  state: ResearchPhaseState,
  directions: Direction[],
): PhaseTransition {
  const closed = allDirectionsClosed(directions);
  if (!closed.ok) return { ok: false, phase: state.phase, reason: closed.reason };
  state.mode = true;
  state.phase = "converging";
  state.activationPrompt = null;
  state.lastRun = null;
  return { ok: true, phase: state.phase };
}

export function sealResearchContract(
  state: ResearchPhaseState,
  contract: GoalContract | null,
  options: { hasBaseline?: boolean } = {},
): PhaseTransition {
  const ready = contractReadyToSeal(contract);
  if (!ready.ok) return { ok: false, phase: state.phase, reason: ready.reason };
  state.mode = true;
  state.phase = options.hasBaseline ? "sealed" : "needs_baseline";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.lastRun = null;
  return { ok: true, phase: state.phase };
}

/**
 * Phase of a research with no contract and no config header yet. A frozen
 * contract or a config header is handled by `enterResearchSealed`
 * before this is asked.
 */
export function detectPreContractPhase(snapshot: {
  hasRules: boolean;
  hasBenchmarkScript: boolean;
}): ResearchPhase {
  return snapshot.hasRules && snapshot.hasBenchmarkScript ? "needs_init" : "inactive";
}

export function activateResearch(
  state: ResearchPhaseState,
  snapshot: ActivationSnapshot,
  options: ResearchProtocolOptions,
): string {
  state.mode = true;
  const hasContract = snapshot.hasContract === true || snapshot.hasConfig;
  state.phase = hasContract ? "sealed" : "framing";
  state.activationPrompt = snapshot.userGoal;
  state.activationTurns = 0;
  state.autoResumeTurns = 0;
  state.lastRun = null;
  return activationMessage(snapshot, options);
}

export function deactivateResearch(state: ResearchPhaseState): void {
  state.mode = false;
  state.phase = "inactive";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.autoResumeTurns = 0;
  state.runsSinceAgentStart = 0;
  state.lastRun = null;
}

export function onResearchInitialized(state: ResearchPhaseState): void {
  state.mode = true;
  state.phase = "needs_baseline";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.lastRun = null;
}

export function onResearchRunFinished(state: ResearchPhaseState, lastRun: LastRunSummary): void {
  state.mode = true;
  state.phase = "awaiting_log";
  state.lastRun = lastRun;
}

export function onResearchRunLogged(state: ResearchPhaseState, limitReached: boolean): void {
  state.runsSinceAgentStart++;
  state.lastRun = null;
  state.phase = limitReached ? "limit_reached" : "sealed";
  if (limitReached) state.mode = false;
}

export function shouldBlockResearchRun(state: ResearchPhaseState): boolean {
  return state.phase === "awaiting_log" && state.lastRun !== null;
}

export function markResearchAutoResumeSent(state: ResearchPhaseState): void {
  state.autoResumeTurns++;
  if (SETUP_PHASES.includes(state.phase)) {
    state.activationTurns++;
  }
}

export function hasReachedResearchAutoResumeLimit(state: ResearchPhaseState, options: ResearchProtocolOptions): boolean {
  return state.autoResumeTurns >= options.maxAutoResumeTurns;
}

export function shouldResearchAutoResumeAfterTurn(state: ResearchPhaseState, options: ResearchProtocolOptions): boolean {
  if (!state.mode) return false;
  if (state.phase === "awaiting_log") return true;
  if (SETUP_PHASES.includes(state.phase)) {
    return state.activationTurns < options.maxActivationTurns;
  }
  if (state.phase === "sealed") {
    return state.runsSinceAgentStart > 0;
  }
  return false;
}

export {
  composeResearchPhaseResumeMessage,
  researchAwaitingLogBlockMessage,
  researchPhaseSystemPromptFor,
};
