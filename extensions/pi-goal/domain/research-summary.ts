import type { ReconstructedResearchState, ReconstructedRun } from "../persistence/research-journal.ts";
import type { MetricDef, ResearchState, RunResult } from "../domain/research-state.ts";

export type RunStatus = ReconstructedRun["status"];

export type StatusCounts = Record<RunStatus, number>;

type SourceRun = ReconstructedRun | RunResult;

export interface ResearchRunSummary {
  source: SourceRun;
  runNumber: number;
  experimentIndex: number;
  commit: string;
  status: RunStatus;
  metric: number;
  metrics: Record<string, number>;
  baselineMetric: number | null;
  deltaPercent: number | null;
  description: string;
  asi: SourceRun["asi"];
}

export interface ResearchSummary {
  name: string | null;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher";
  currentExperimentIndex: number;
  totalRunCount: number;
  confidence: number | null;
  secondaryMetrics: MetricDef[];
  currentExperiment: {
    runs: ResearchRunSummary[];
    runCount: number;
    statusCounts: StatusCounts;
    baseline: ResearchRunSummary | null;
    best: ResearchRunSummary | null;
    baselineSecondary: Record<string, number>;
  };
  recentRuns: ResearchRunSummary[];
}

export function buildResearchSummary(
  state: ReconstructedResearchState,
  options: { recentRunLimit?: number } = {},
): ResearchSummary {
  return buildSummary({
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    direction: state.bestDirection,
    currentExperimentIndex: state.currentExperimentIndex,
    results: state.results,
    secondaryMetrics: state.secondaryMetrics,
    confidence: null,
  }, options);
}

export function buildResearchSummaryFromState(
  state: ResearchState,
  options: { recentRunLimit?: number } = {},
): ResearchSummary {
  return buildSummary({
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    direction: state.bestDirection,
    currentExperimentIndex: state.currentExperimentIndex,
    results: state.results,
    secondaryMetrics: state.secondaryMetrics,
    confidence: state.confidence,
  }, options);
}

export function isBetterMetric(
  value: number,
  current: number,
  direction: "lower" | "higher",
): boolean {
  return direction === "lower" ? value < current : value > current;
}

function buildSummary(
  state: {
    name: string | null;
    metricName: string;
    metricUnit: string;
    direction: "lower" | "higher";
    currentExperimentIndex: number;
    results: SourceRun[];
    secondaryMetrics: MetricDef[];
    confidence: number | null;
  },
  options: { recentRunLimit?: number },
): ResearchSummary {
  const allRuns = state.results.map((run, index) =>
    runSummary(run, runNumberFor(run, index), baselineMetricFor(run, state.results)),
  );
  const currentRuns = allRuns.filter((run) => run.experimentIndex === state.currentExperimentIndex);
  const baseline = currentRuns[0] ?? null;
  const best = bestKeptRun(currentRuns, state.direction);
  const recentRunLimit = options.recentRunLimit ?? 50;

  return {
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    direction: state.direction,
    currentExperimentIndex: state.currentExperimentIndex,
    totalRunCount: state.results.length,
    confidence: state.confidence,
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
    currentExperiment: {
      runs: currentRuns,
      runCount: currentRuns.length,
      statusCounts: countByStatus(currentRuns),
      baseline,
      best,
      baselineSecondary: baselineSecondaryFor(currentRuns, state.secondaryMetrics),
    },
    recentRuns: allRuns.slice(-recentRunLimit),
  };
}

function runSummary(run: SourceRun, runNumber: number, baselineMetric: number | null): ResearchRunSummary {
  return {
    source: run,
    runNumber,
    experimentIndex: run.experimentIndex,
    commit: run.commit,
    status: run.status,
    metric: run.metric,
    metrics: { ...(run.metrics ?? {}) },
    baselineMetric,
    deltaPercent: deltaPercent(run.metric, baselineMetric),
    description: run.description,
    asi: run.asi,
  };
}

function runNumberFor(run: SourceRun, index: number): number {
  return "run" in run && typeof run.run === "number" ? run.run : index + 1;
}

function baselineMetricFor(run: SourceRun, allRuns: SourceRun[]): number | null {
  const baseline = allRuns.find((other) => other.experimentIndex === run.experimentIndex);
  return baseline?.metric ?? null;
}

function baselineSecondaryFor(
  runs: ResearchRunSummary[],
  knownMetrics: MetricDef[],
): Record<string, number> {
  const base: Record<string, number> = runs.length > 0 ? { ...runs[0].metrics } : {};
  for (const metric of knownMetrics) {
    if (base[metric.name] !== undefined) continue;
    for (const run of runs) {
      const value = run.metrics[metric.name];
      if (value === undefined) continue;
      base[metric.name] = value;
      break;
    }
  }
  return base;
}

function bestKeptRun(
  runs: ResearchRunSummary[],
  direction: "lower" | "higher",
): ResearchRunSummary | null {
  const kept = runs.filter((run) => run.status === "keep" && Number.isFinite(run.metric));
  if (kept.length === 0) return null;
  return kept.reduce((best, run) => (isBetterMetric(run.metric, best.metric, direction) ? run : best));
}

function countByStatus(runs: ResearchRunSummary[]): StatusCounts {
  const counts: StatusCounts = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const run of runs) counts[run.status]++;
  return counts;
}

function deltaPercent(value: number, baseline: number | null): number | null {
  if (baseline === null || baseline === 0 || value === baseline) return null;
  return ((value - baseline) / baseline) * 100;
}
