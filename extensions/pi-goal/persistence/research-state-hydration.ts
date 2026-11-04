import {
  computeConfidence,
  createResearchState,
  findBaselineMetric,
  type ResearchState,
} from "../domain/research-state.ts";
import { legacyMetricContract } from "../domain/goal-contract.ts";
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
  state.contract = model.contract
    ? {
        ...model.contract,
        criteria: model.contract.criteria.map((criterion) => ({
          ...criterion,
          check: criterion.check ? { ...criterion.check } : undefined,
          metric: criterion.metric ? { ...criterion.metric } : undefined,
        })),
        testGlobs: [...model.contract.testGlobs],
        scopeGlobs: [...model.contract.scopeGlobs],
      }
    : model.hasConfig
      ? legacyMetricContract({
          metricName: model.metricName,
          direction: model.bestDirection,
        })
      : null;
  state.directions = model.directions.map((direction) => ({
    ...direction,
    evidence: direction.evidence ? { ...direction.evidence } : undefined,
  }));
  state.probes = model.probes.map((probe) => ({ ...probe }));
  state.gates = model.gates.map((gate) => ({
    ...gate,
    criteria: gate.criteria.map((verdict) => ({ ...verdict })),
  }));
  state.reviews = model.reviews.map((review) => ({
    ...review,
    findings: review.findings.map((finding) => ({
      ...finding,
      repro: finding.repro ? { ...finding.repro } : undefined,
    })),
  }));
  state.attempts = model.attempts.map((attempt) => ({ ...attempt }));
  state.testEditsAllowed = model.testEditsAllowed;
  state.benchmarkEditsAllowed = model.benchmarkEditsAllowed;

  if (state.results.length === 0) return false;
  state.baselineMetric = findBaselineMetric(state.results, state.currentExperimentIndex);
  state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
  return true;
}
