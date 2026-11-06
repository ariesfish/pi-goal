import { createResearchState, type ResearchState } from "../domain/research-state.ts";
import { legacyMetricContract } from "../domain/goal-contract.ts";
import { parseResearchJournal } from "./research-journal-codec.ts";

export function researchStateFromJournal(jsonlContent: string): ResearchState {
  const state = createResearchState();
  hydrateResearchStateFromJournal(state, jsonlContent);
  return state;
}

/**
 * Replay the journal into an existing state. Returns whether the journal holds
 * at least one Run Result.
 */
export function hydrateResearchStateFromJournal(state: ResearchState, jsonlContent: string): boolean {
  const { state: parsed, hasConfig } = parseResearchJournal(jsonlContent);
  Object.assign(state, parsed);

  // Legacy journals carry no contract entry; a config header is enough to
  // hydrate the one-criterion metric contract the phased protocol replaced.
  if (!state.contract && hasConfig) {
    state.contract = legacyMetricContract({
      metricName: state.metricName,
      direction: state.bestDirection,
    });
  }

  return state.results.length > 0;
}
