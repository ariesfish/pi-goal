/**
 * Deterministic compaction summary for research.
 *
 * Replaces the default LLM-generated summary with a synthesized view of
 * persisted state — experiment rules, ideas backlog, and recent runs.
 * Everything that matters between iterations already lives on disk, so we
 * skip the LLM call entirely and keep the summary lossless on what counts.
 */

import * as fs from "node:fs";
import {
  reconstructResearchStateFromJournal,
} from "../persistence/research-journal.ts";
import {
  researchIdeasPath,
  researchJournalPath,
  researchRulesPath,
} from "../persistence/research-paths.ts";
import {
  buildResearchSummary,
  type ResearchSummary,
  type ResearchRunSummary,
} from "../domain/research-summary.ts";

const RECENT_RUN_LIMIT = 50;

export interface ResearchSummaryPaths {
  workDir: string;
  jsonlPath: string;
  mdPath: string;
  ideasPath: string;
}

export function researchSummaryPathsFor(workDir: string): ResearchSummaryPaths {
  return {
    workDir,
    jsonlPath: researchJournalPath(workDir),
    mdPath: researchRulesPath(workDir),
    ideasPath: researchIdeasPath(workDir),
  };
}

/**
 * Build the full compaction summary text from persisted research state.
 * Returns a markdown string that is itself the entire compaction summary.
 */
export function buildResearchCompactionSummary(paths: ResearchSummaryPaths): string {
  const model = loadSummary(paths.jsonlPath);
  const sections = [
    headerSection(),
    researchSection(model),
    rulesSection(paths.mdPath),
    ideasSection(paths.ideasPath),
    recentRunsSection(model),
    nextStepSection(),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function loadSummary(jsonlPath: string): ResearchSummary {
  return buildResearchSummary(
    reconstructResearchStateFromJournal(readFileOrEmpty(jsonlPath)),
    { recentRunLimit: RECENT_RUN_LIMIT },
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function headerSection(): string {
  return [
    "# Research Compaction Summary",
    "",
    "The conversation history was discarded; the persisted research state below is the source of truth.",
    "Continue the research loop using only what is included here plus the live tools.",
  ].join("\n");
}

function researchSection(model: ResearchSummary): string {
  const lines = [
    "## Research",
    "",
    `Goal: ${model.name ?? "—"}`,
    `Metric: ${model.metricName} — ${model.direction} is better`,
    runCountLine(model),
    ...baselineAndBestLines(model),
  ];
  return lines.join("\n");
}

function runCountLine(model: ResearchSummary): string {
  const { runCount, statusCounts: counts } = model.currentExperiment;
  if (runCount === 0) return "Runs so far: 0";
  const parts = [
    `${counts.keep} keep`,
    counts.discard ? `${counts.discard} discard` : "",
    counts.crash ? `${counts.crash} crash` : "",
    counts.checks_failed ? `${counts.checks_failed} checks_failed` : "",
  ].filter(Boolean);
  return `Runs so far: ${runCount} (${parts.join(" · ")})`;
}

function baselineAndBestLines(model: ResearchSummary): string[] {
  const baseline = model.currentExperiment.baseline;
  if (!baseline) return [];
  const lines = [`Baseline (#${baseline.runNumber}): ${formatMetricWithUnit(baseline.metric, model.metricUnit)}`];
  const best = model.currentExperiment.best;
  if (best && best.runNumber !== baseline.runNumber) {
    lines.push(
      `Best     (#${best.runNumber}): ${formatMetricWithUnit(best.metric, model.metricUnit)}${formatDeltaPercent(best.deltaPercent)}`,
    );
  }
  return lines;
}

function formatMetricWithUnit(value: number, unit: string): string {
  return `${formatMetric(value)}${unit}`;
}

function rulesSection(mdPath: string): string {
  const content = readTrimmedFile(mdPath);
  if (!content) return "";
  return `## Research Rules (goal.md)\n\n${content}`;
}

function ideasSection(ideasPath: string): string {
  const content = readTrimmedFile(ideasPath);
  if (!content) return "";
  return `## Ideas Backlog (goal.ideas.md)\n\n${content}`;
}

function recentRunsSection(model: ResearchSummary): string {
  const runs = model.recentRuns;
  if (runs.length === 0) {
    return "## Recent Runs\n\nNo runs yet — start with the first hypothesis.";
  }
  const lines = runs.map(formatRunLine);
  return [
    `## Recent Runs (last ${runs.length})`,
    "",
    "Format: `#run status metric (delta) | desc | hyp: ... | next: ... | rollback: ...`",
    "",
    ...lines,
    "",
    "If you need more details, read additional lines from goal.jsonl.",
  ].join("\n");
}

function nextStepSection(): string {
  return [
    "## Next Step",
    "",
    "Pick the most promising hypothesis (from the ideas backlog or the latest `next:` hints in recent runs)",
    "and run the next measured run immediately. Do not stop until interrupted.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

function formatRunLine(run: ResearchRunSummary): string {
  const head = `#${run.runNumber} ${padStatus(run.status)} ${formatMetric(run.metric)}${formatDeltaPercent(run.deltaPercent)}`;
  const parts = [head, formatDescription(run), ...formatAsiFields(run.asi)];
  return parts.filter(Boolean).join(" | ");
}

function padStatus(status: ResearchRunSummary["status"]): string {
  return status.padEnd(STATUS_WIDTH);
}

const STATUS_WIDTH = "checks_failed".length;

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function formatDeltaPercent(pct: number | null): string {
  if (pct === null) return "";
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct.toFixed(1)}%)`;
}

function formatDescription(run: ResearchRunSummary): string {
  return run.description ? `desc: ${run.description}` : "";
}

function formatAsiFields(asi: ResearchRunSummary["asi"]): string[] {
  if (!asi) return [];
  return [
    formatAsiField(asi, "hypothesis", "hyp"),
    formatAsiField(asi, "next_action_hint", "next"),
    formatAsiField(asi, "rollback_reason", "rollback"),
  ];
}

function formatAsiField(asi: Record<string, unknown>, key: string, label: string): string {
  const value = asi[key];
  if (typeof value !== "string" || value.trim() === "") return "";
  return `${label}: ${value.trim()}`;
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readTrimmedFile(filePath: string): string {
  return readFileOrEmpty(filePath).trim();
}

function readFileOrEmpty(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
