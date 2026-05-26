import {
  computeConfidence,
  createResearchState,
  findBaselineMetric,
  type ResearchState,
} from "../domain/research-state.ts";
import {
  parseResearchJournalModel,
  type ResearchJournalModel,
} from "./research-journal-codec.ts";

export function researchStateFromJournal(jsonlContent: string): ResearchState {
  return researchStateFromJournalModel(parseResearchJournalModel(jsonlContent));
}

export function researchStateFromJournalModel(model: ResearchJournalModel): ResearchState {
  const state = createResearchState();
  hydrateResearchStateFromJournalModel(state, model);
  return state;
}

export function hydrateResearchStateFromJournal(state: ResearchState, jsonlContent: string): boolean {
  return hydrateResearchStateFromJournalModel(state, parseResearchJournalModel(jsonlContent));
}

export function hydrateResearchStateFromJournalModel(state: ResearchState, model: ResearchJournalModel): boolean {
  state.name = model.name;
  state.metricName = model.metricName;
  state.metricUnit = model.metricUnit;
  state.bestDirection = model.bestDirection;
  state.currentExperimentIndex = model.currentExperimentIndex;
  state.results = model.results.map((result) => ({
    commit: result.commit,
    metric: result.metric,
    metrics: { ...result.metrics },
    status: result.status,
    description: result.description,
    timestamp: result.timestamp,
    experimentIndex: result.experimentIndex,
    confidence: result.confidence,
    asi: result.asi ? { ...result.asi } : undefined,
  }));
  state.secondaryMetrics = model.secondaryMetrics.map((metric) => ({ ...metric }));

  if (state.results.length === 0) return false;
  state.bestMetric = findBaselineMetric(state.results, state.currentExperimentIndex);
  state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
  return true;
}
