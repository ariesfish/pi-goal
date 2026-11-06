import type { ResearchState } from "../domain/research-state.ts";
import { legacyMetricContract } from "../domain/goal-contract.ts";
import { parseResearchJournal, type ParsedJournal } from "./research-journal-codec.ts";

/**
 * Parse the journal and normalize it: legacy journals carry no contract entry,
 * so a config header hydrates the one-criterion metric contract the phased
 * protocol replaced. Callers that cache this must treat the state as read-only.
 */
export function replayJournal(jsonlContent: string): ParsedJournal {
  const parsed = parseResearchJournal(jsonlContent);
  if (!parsed.state.contract && parsed.hasConfig) {
    parsed.state.contract = legacyMetricContract({
      metricName: parsed.state.metricName,
      direction: parsed.state.bestDirection,
    });
  }
  return parsed;
}

export function researchStateFromJournal(jsonlContent: string): ResearchState {
  return replayJournal(jsonlContent).state;
}

/**
 * Replay the journal into an existing state. Returns whether the journal holds
 * at least one Run Result.
 */
export function hydrateResearchStateFromJournal(state: ResearchState, jsonlContent: string): boolean {
  const replay = replayJournal(jsonlContent);
  Object.assign(state, replay.state);
  return replay.state.results.length > 0;
}
