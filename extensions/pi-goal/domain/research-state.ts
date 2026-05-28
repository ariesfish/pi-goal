import { inferMetricUnit } from "./metric-definition.ts";
export { inferMetricUnit };

export interface ASI {
  [key: string]: unknown;
}

export interface RunResult {
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  experimentIndex: number;
  confidence: number | null;
  asi?: ASI;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ResearchState {
  results: RunResult[];
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  name: string | null;
  currentExperimentIndex: number;
  runLimit: number | null;
  confidence: number | null;
}

export function createResearchState(): ResearchState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentExperimentIndex: 0,
    runLimit: null,
    confidence: null,
  };
}

export function cloneResearchState(state: ResearchState): ResearchState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
      asi: result.asi ? { ...result.asi } : undefined,
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

export function currentRuns(results: RunResult[], experimentIndex: number): RunResult[] {
  return results.filter((result) => result.experimentIndex === experimentIndex);
}

export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher",
): boolean {
  return direction === "lower" ? current < best : current > best;
}

export function registerSecondaryMetrics(state: ResearchState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

export function findBaselineMetric(results: RunResult[], experimentIndex: number): number | null {
  const cur = currentRuns(results, experimentIndex);
  return cur.length > 0 ? cur[0].metric : null;
}

export function findBaselineRunNumber(results: RunResult[], experimentIndex: number): number | null {
  const index = results.findIndex((result) => result.experimentIndex === experimentIndex);
  return index >= 0 ? index + 1 : null;
}

export function findBestMetric(
  results: RunResult[],
  experimentIndex: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentRuns(results, experimentIndex)
    .filter((result) => result.status === "keep")
    .map((result) => result.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

export function findBaselineSecondary(
  results: RunResult[],
  experimentIndex: number,
  knownMetrics?: MetricDef[],
): Record<string, number> {
  const cur = currentRuns(results, experimentIndex);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  if (knownMetrics) {
    for (const metric of knownMetrics) {
      if (base[metric.name] !== undefined) continue;
      for (const result of cur) {
        const value = (result.metrics ?? {})[metric.name];
        if (value === undefined) continue;
        base[metric.name] = value;
        break;
      }
    }
  }

  return base;
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function computeConfidence(
  results: RunResult[],
  experimentIndex: number,
  direction: "lower" | "higher",
): number | null {
  const cur = currentRuns(results, experimentIndex).filter((result) => result.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((result) => result.metric);
  const median = sortedMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = sortedMedian(deviations);
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, experimentIndex);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const result of cur) {
    if (result.status !== "keep" || result.metric <= 0) continue;
    if (bestKept === null || isBetter(result.metric, bestKept, direction)) {
      bestKept = result.metric;
    }
  }

  if (bestKept === null || bestKept === baseline) return null;
  return Math.abs(bestKept - baseline) / mad;
}
