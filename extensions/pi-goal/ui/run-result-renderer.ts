import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";

import {
  EXPERIMENT_MAX_BYTES,
  type RunDetails,
} from "../execution/experiment-runner.ts";
import { inferMetricUnit } from "../domain/metric-definition.ts";
import { formatMetricValue } from "./metric-format.ts";

const PREVIEW_LINES = 5;

export interface RunExperimentResponseOptions {
  details: RunDetails;
  llmOutput: string;
  truncation?: {
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    outputLines: number;
    totalLines?: number;
  };
  fullOutputPath?: string;
  requirePrimaryMetric: boolean;
  bestMetric?: number | null;
}

export function buildRunExperimentResponseText(options: RunExperimentResponseOptions): string {
  const { details, llmOutput, truncation, fullOutputPath, requirePrimaryMetric } = options;
  const benchmarkPassed = details.exitCode === 0 && !details.timedOut;
  const missingPrimaryMetric = benchmarkPassed && requirePrimaryMetric && details.parsedPrimary === null;

  let text = runStatusText(details, missingPrimaryMetric);

  if (options.bestMetric !== null && options.bestMetric !== undefined) {
    text += `📊 Current best ${details.metricName}: ${formatMetricValue(options.bestMetric, details.metricUnit)}\n`;
  }

  if (details.parsedMetrics) {
    text += parsedMetricsText(details);
  }

  text += `\n${llmOutput}`;

  if (truncation) {
    text += truncationText(truncation, fullOutputPath);
  }

  if (details.checksPass === false) {
    text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
  }

  return text;
}

function runStatusText(details: RunDetails, missingPrimaryMetric: boolean): string {
  const benchmarkPassed = details.exitCode === 0 && !details.timedOut;
  let text = "";

  if (details.timedOut) {
    text += `⏰ TIMEOUT after ${details.durationSeconds.toFixed(1)}s\n`;
  } else if (!benchmarkPassed) {
    text += `💥 FAILED (exit code ${details.exitCode}) in ${details.durationSeconds.toFixed(1)}s\n`;
  } else if (missingPrimaryMetric) {
    text += `❌ PRIMARY METRIC MISSING after ${details.durationSeconds.toFixed(1)}s\n`;
    text += `Expected output line: METRIC ${details.metricName}=<number>\n`;
    text += `Parsed metrics: ${details.parsedMetrics ? Object.keys(details.parsedMetrics).join(", ") : "(none)"}\n`;
    text += `Fix goal.sh or call start_goal with the correct metric name. Log this as 'crash' if you cannot fix it in this turn.\n`;
  } else if (details.checksTimedOut) {
    text += `✅ Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
    text += `⏰ CHECKS TIMEOUT (goal.checks.sh) after ${details.checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
  } else if (details.checksPass === false) {
    text += `✅ Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
    text += `💥 CHECKS FAILED (goal.checks.sh) in ${details.checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
  } else {
    text += `✅ PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
    if (details.checksPass === true) {
      text += `✅ Checks passed in ${details.checksDuration.toFixed(1)}s\n`;
    }
  }

  return text;
}

function parsedMetricsText(details: RunDetails): string {
  const parsedMetrics = details.parsedMetrics;
  if (!parsedMetrics) return "";

  const secondary = Object.entries(parsedMetrics).filter(([name]) => name !== details.metricName);
  let text = `\n📐 Parsed metrics:`;
  if (details.parsedPrimary !== null) {
    text += ` ★ ${details.metricName}=${formatMetricValue(details.parsedPrimary, details.metricUnit)}`;
  }
  for (const [name, value] of secondary) {
    text += ` ${name}=${formatMetricValue(value, inferMetricUnit(name))}`;
  }
  text += `\nUse these values directly in log_goal (metric: ${details.parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
  return text;
}

function truncationText(
  truncation: NonNullable<RunExperimentResponseOptions["truncation"]>,
  fullOutputPath: string | undefined,
): string {
  let text = "";
  if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines.`;
  } else {
    text += `\n\n[Showing last ${truncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
  }
  if (fullOutputPath) {
    text += ` Full output: ${fullOutputPath}`;
  }
  text += `]`;
  return text;
}

export function renderRunExperimentPartialText(options: {
  outputText: string;
  elapsed?: string;
  expanded: boolean;
  theme: Theme;
}): string {
  const { outputText, elapsed = "", expanded, theme } = options;
  let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

  if (!outputText) return text;

  const lines = outputText.split("\n");
  const maxLines = expanded ? 20 : PREVIEW_LINES;
  const tail = lines.slice(-maxLines).join("\n");
  if (tail.trim()) {
    text += "\n" + theme.fg("dim", tail);
  }
  return text;
}

export function renderRunExperimentResultText(options: {
  details: RunDetails & { truncation?: { truncated?: boolean }; fullOutputPath?: string };
  expanded: boolean;
  theme: Theme;
}): string {
  const { details, expanded, theme } = options;

  const appendOutput = (text: string, output: string): string => {
    if (!output) return text;
    const lines = output.split("\n");
    if (expanded) {
      return text + "\n" + theme.fg("dim", output.slice(-2000));
    }

    const tail = lines.slice(-PREVIEW_LINES).join("\n");
    if (!tail.trim()) return text;

    const hidden = lines.length - PREVIEW_LINES;
    if (hidden > 0) {
      text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
    }
    return text + "\n" + theme.fg("dim", tail);
  };

  if (details.timedOut) {
    return appendOutput(theme.fg("error", `⏰ TIMEOUT ${details.durationSeconds.toFixed(1)}s`), details.tailOutput);
  }

  const parsedSuffix = details.parsedPrimary !== null
    ? theme.fg("accent", `, ${details.metricName}: ${formatMetricValue(details.parsedPrimary, details.metricUnit)}`)
    : "";

  if (details.checksTimedOut) {
    return appendOutput(
      theme.fg("success", `✅ wall: ${details.durationSeconds.toFixed(1)}s`) +
        parsedSuffix +
        theme.fg("error", ` ⏰ checks timeout ${details.checksDuration.toFixed(1)}s`),
      details.checksOutput,
    );
  }

  if (details.checksPass === false) {
    return appendOutput(
      theme.fg("success", `✅ wall: ${details.durationSeconds.toFixed(1)}s`) +
        parsedSuffix +
        theme.fg("error", ` 💥 checks failed ${details.checksDuration.toFixed(1)}s`),
      details.checksOutput,
    );
  }

  if (details.crashed) {
    return appendOutput(
      theme.fg("error", `💥 FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`) + parsedSuffix,
      details.tailOutput,
    );
  }

  const parts: string[] = [`wall: ${details.durationSeconds.toFixed(1)}s`];
  if (details.parsedPrimary !== null) {
    parts.push(`${details.metricName}: ${formatMetricValue(details.parsedPrimary, details.metricUnit)}`);
  }

  let text = theme.fg("success", "✅ ") + theme.fg("accent", parts.join(", "));

  if (details.checksPass === true) {
    text += theme.fg("success", ` ✓ checks ${details.checksDuration.toFixed(1)}s`);
  }

  if (details.truncation?.truncated && details.fullOutputPath) {
    text += theme.fg("warning", " (truncated)");
  }

  text = appendOutput(text, details.tailOutput);

  if (expanded && details.truncation?.truncated && details.fullOutputPath) {
    text += "\n" + theme.fg("warning", `[Truncated output. Full output: ${details.fullOutputPath}]`);
  }

  return text;
}
