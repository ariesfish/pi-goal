import { buildResearchSummaryFromState } from "../domain/research-summary.ts";
import type { AppliedRunResult, LogRunParams } from "../domain/run-result.ts";
import type { ASI, ResearchState } from "../domain/research-state.ts";
import { formatMetricValue } from "./metric-format.ts";

export function formatLogSummary(options: {
  state: ResearchState;
  applied: AppliedRunResult;
  params: LogRunParams;
}): string {
  const { state, applied, params } = options;
  const { runResult, runCount, secondaryMetrics, mergedASI } = applied;
  const summary = buildResearchSummaryFromState(state);
  const baseline = summary.currentExperiment.baseline;
  let text = `Logged #${state.results.length}: ${runResult.status} — ${runResult.description}`;

  if (baseline !== null) {
    text += `\nBaseline ${state.metricName}: ${formatMetricValue(baseline.metric, state.metricUnit)}`;
    if (runCount > 1 && params.status === "keep" && params.metric > 0 && baseline.metric !== 0) {
      const delta = params.metric - baseline.metric;
      const pct = ((delta / baseline.metric) * 100).toFixed(1);
      const sign = delta > 0 ? "+" : "";
      text += ` | this: ${formatMetricValue(params.metric, state.metricUnit)} (${sign}${pct}%)`;
    }
  }

  if (Object.keys(secondaryMetrics).length > 0) {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(secondaryMetrics)) {
      const def = state.secondaryMetrics.find((m) => m.name === name);
      const unit = def?.unit ?? "";
      let part = `${name}: ${formatMetricValue(value, unit)}`;
      const bv = summary.currentExperiment.baselineSecondary[name];
      if (bv !== undefined && state.results.length > 1 && bv !== 0) {
        const d = value - bv;
        const p = ((d / bv) * 100).toFixed(1);
        const s = d > 0 ? "+" : "";
        part += ` (${s}${p}%)`;
      }
      parts.push(part);
    }
    text += `\nSecondary: ${parts.join("  ")}`;
  }

  text += formatAsiSummary(mergedASI);
  text += formatConfidenceSummary(state.confidence);
  text += `\n(${runCount} runs in current experiment`;
  if (state.runLimit !== null) {
    text += ` / ${state.runLimit} max`;
  }
  text += `)`;

  return text;
}

function formatAsiSummary(mergedASI: ASI | undefined): string {
  if (!mergedASI) return "";
  const asiParts: string[] = [];
  for (const [k, v] of Object.entries(mergedASI)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
  }
  return asiParts.length > 0 ? `\n📋 ASI: ${asiParts.join(" | ")}` : "";
}

function formatConfidenceSummary(confidence: number | null): string {
  if (confidence === null) return "";
  const confStr = confidence.toFixed(1);
  if (confidence >= 2.0) {
    return `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
  }
  if (confidence >= 1.0) {
    return `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
  }
  return `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
}
