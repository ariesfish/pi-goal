import { findBestMetric, type ResearchState } from "./research-state.ts";

export interface ResearchSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export function buildResearchSnapshot(state: ResearchState): ResearchSnapshot {
  return {
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: findBestMetric(state.results, state.currentExperimentIndex, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  };
}
