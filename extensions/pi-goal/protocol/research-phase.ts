import {
  activationMessage,
  composeResearchPhaseCompactionResumeMessage,
  composeResearchPhaseResumeMessage,
  researchAwaitingLogBlockMessage,
  researchPhaseSystemPromptFor,
} from "./research-phase-prompts.ts";

export type ResearchPhase =
  | "inactive"
  | "activating"
  | "needs_init"
  | "needs_baseline"
  | "awaiting_log"
  | "looping"
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
  pendingResumeMessage: string | null;
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

export function createResearchPhaseState(): ResearchPhaseState {
  return {
    mode: false,
    phase: "inactive",
    activationPrompt: null,
    activationTurns: 0,
    autoResumeTurns: 0,
    runsSinceAgentStart: 0,
    pendingResumeMessage: null,
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

export function enterResearchLoopingFromPersistedLog(state: ResearchPhaseState): void {
  enterResearchLooping(state);
}

export function enterResearchLoopingFromFiles(state: ResearchPhaseState): void {
  enterResearchLooping(state);
}

export function enterResearchNeedsInitFromFiles(state: ResearchPhaseState): void {
  state.mode = true;
  state.phase = "needs_init";
  state.activationPrompt = null;
  state.lastRun = null;
}

function enterResearchLooping(state: ResearchPhaseState): void {
  state.mode = true;
  state.phase = "looping";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.lastRun = null;
}

export function detectPhaseFromFiles(snapshot: Pick<ActivationSnapshot, "hasRules" | "hasConfig" | "hasBenchmarkScript">): ResearchPhase {
  if (snapshot.hasConfig) return "looping";
  if (snapshot.hasRules && snapshot.hasBenchmarkScript) return "needs_init";
  return "inactive";
}

export function activateResearch(
  state: ResearchPhaseState,
  snapshot: ActivationSnapshot,
  options: ResearchProtocolOptions,
): string {
  state.mode = true;
  state.phase = activationPhase(snapshot);
  state.activationPrompt = snapshot.userGoal;
  state.activationTurns = 0;
  state.autoResumeTurns = 0;
  state.pendingResumeMessage = null;
  state.lastRun = null;
  return activationMessage(snapshot, options);
}

function activationPhase(snapshot: ActivationSnapshot): ResearchPhase {
  if (!snapshot.hasConfig) return snapshot.hasRules && snapshot.hasBenchmarkScript ? "needs_init" : "activating";
  return "looping";
}

export function deactivateResearch(state: ResearchPhaseState): void {
  state.mode = false;
  state.phase = "inactive";
  state.activationPrompt = null;
  state.activationTurns = 0;
  state.autoResumeTurns = 0;
  state.runsSinceAgentStart = 0;
  state.pendingResumeMessage = null;
  state.lastRun = null;
}

export function clearResearchPhase(state: ResearchPhaseState): void {
  deactivateResearch(state);
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
  state.phase = limitReached ? "limit_reached" : "looping";
  if (limitReached) state.mode = false;
}

export function shouldBlockResearchRun(state: ResearchPhaseState): boolean {
  return state.phase === "awaiting_log" && state.lastRun !== null;
}

export function hasPendingResearchPhaseResume(state: ResearchPhaseState): boolean {
  return state.pendingResumeMessage !== null;
}

export function pausePendingResearchPhaseResume(_state: ResearchPhaseState): void {
  // Timer ownership stays in the extension adapter. This function documents the seam.
}

export function cancelPendingResearchPhaseResume(state: ResearchPhaseState): void {
  state.pendingResumeMessage = null;
}

export function markResearchAutoResumeSent(state: ResearchPhaseState): void {
  state.autoResumeTurns++;
  if (state.phase === "activating" || state.phase === "needs_init" || state.phase === "needs_baseline") {
    state.activationTurns++;
  }
}

export function hasReachedResearchAutoResumeLimit(state: ResearchPhaseState, options: ResearchProtocolOptions): boolean {
  return state.autoResumeTurns >= options.maxAutoResumeTurns;
}

export function shouldResearchAutoResumeAfterTurn(state: ResearchPhaseState, options: ResearchProtocolOptions): boolean {
  if (!state.mode) return false;
  if (state.phase === "awaiting_log") return true;
  if (state.phase === "activating" || state.phase === "needs_init" || state.phase === "needs_baseline") {
    return state.activationTurns < options.maxActivationTurns;
  }
  if (state.phase === "looping") {
    return state.runsSinceAgentStart > 0;
  }
  return false;
}

export function shouldResearchAutoResumeAfterCompact(state: ResearchPhaseState): boolean {
  return state.mode;
}

export {
  composeResearchPhaseCompactionResumeMessage,
  composeResearchPhaseResumeMessage,
  researchAwaitingLogBlockMessage,
  researchPhaseSystemPromptFor,
};
