import {
  computeConfidence,
  currentRuns,
  findBaselineMetric,
  registerSecondaryMetrics,
  type ASI,
  type ResearchState,
  type RunResult,
} from "./research-state.ts";

export interface LogRunParams {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: Record<string, unknown>;
}

export interface AppliedRunResult {
  runResult: RunResult;
  runCount: number;
  secondaryMetrics: Record<string, number>;
  mergedASI: ASI | undefined;
}

export function validateRunResultInput(options: {
  state: ResearchState;
  params: LogRunParams;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
}): string | null {
  const { state, params, lastRunChecks } = options;
  if (params.status === "keep" && lastRunChecks && !lastRunChecks.pass) {
    return `❌ Cannot keep — goal.checks.sh failed.\n\n${lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`;
  }

  return validateSecondaryMetrics(state, params.metrics ?? {}, params.force === true);
}

export function applyRunResult(state: ResearchState, params: LogRunParams): AppliedRunResult {
  const secondaryMetrics = params.metrics ?? {};
  const mergedASI = params.asi && Object.keys(params.asi).length > 0
    ? params.asi as ASI
    : undefined;

  const runResult: RunResult = {
    commit: params.commit.slice(0, 7),
    metric: params.metric,
    metrics: secondaryMetrics,
    status: params.status,
    description: params.description,
    timestamp: Date.now(),
    experimentIndex: state.currentExperimentIndex,
    confidence: null,
    asi: mergedASI,
  };

  state.results.push(runResult);
  registerSecondaryMetrics(state, secondaryMetrics);
  state.bestMetric = findBaselineMetric(state.results, state.currentExperimentIndex);
  state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
  runResult.confidence = state.confidence;

  return {
    runResult,
    runCount: currentRuns(state.results, state.currentExperimentIndex).length,
    secondaryMetrics,
    mergedASI,
  };
}

function validateSecondaryMetrics(
  state: ResearchState,
  secondaryMetrics: Record<string, number>,
  force: boolean,
): string | null {
  if (state.secondaryMetrics.length === 0) return null;

  const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
  const providedNames = new Set(Object.keys(secondaryMetrics));

  const missing = [...knownNames].filter((n) => !providedNames.has(n));
  if (missing.length > 0) {
    return `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`;
  }

  const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
  if (newMetrics.length > 0 && !force) {
    return `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_goal again with force: true to add it. Otherwise, remove it from the metrics parameter.`;
  }

  return null;
}
