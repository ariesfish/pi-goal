/**
 * Deterministic compaction summary for research.
 *
 * Replaces the default LLM-generated summary with a synthesized view of
 * persisted state — experiment rules, ideas backlog, and recent runs.
 * Everything that matters between iterations already lives on disk, so we
 * skip the LLM call entirely and keep the summary lossless on what counts.
 */

import * as fs from "node:fs";
import { researchStateFromJournal } from "../persistence/research-state-hydration.ts";
import type { ResearchState } from "../domain/research-state.ts";
import type { ResearchPhase } from "../protocol/research-phase.ts";
import { activeResearch } from "../persistence/research-directory.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import {
  buildResearchSummaryFromState,
  type ResearchSummary,
  type ResearchRunSummary,
} from "../domain/research-summary.ts";
import { formatDeltaSuffix, formatPlainMetric } from "./metric-format.ts";

const RECENT_RUN_LIMIT = 50;

export interface ResearchSummaryPaths {
  workDir: string;
  jsonlPath: string;
  mdPath: string;
  ideasPath: string;
}

export function researchSummaryPathsFor(workDir: string): ResearchSummaryPaths {
  const contract = readResearchFileContract(workDir);
  return {
    workDir,
    jsonlPath: activeResearch(workDir).paths.journal,
    mdPath: contract.rulesPath,
    ideasPath: contract.ideasPath,
  };
}

/**
 * Build the full compaction summary text from persisted research state.
 * Returns a markdown string that is itself the entire compaction summary.
 */
export function buildResearchCompactionSummary(
  paths: ResearchSummaryPaths,
  phase: ResearchPhase = "sealed",
): string {
  const state = researchStateFromJournal(readFileOrEmpty(paths.jsonlPath));
  const model = buildResearchSummaryFromState(state, { recentRunLimit: RECENT_RUN_LIMIT });
  const sections = [
    headerSection(),
    phaseSection(phase),
    contractSection(state),
    directionsSection(state),
    researchSection(model),
    gatesSection(state),
    attemptsSection(state),
    rulesSection(paths.mdPath),
    ideasSection(paths.ideasPath),
    recentRunsSection(model),
    nextStepSection(phase),
  ];
  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function phaseSection(phase: ResearchPhase): string {
  return `## Phase\n\n${phase}`;
}

function contractSection(state: ResearchState): string {
  const contract = state.contract;
  if (!contract) {
    return "## Goal Contract\n\nNot frozen yet. Frame directions and freeze criteria before running.";
  }
  const lines = [
    "## Goal Contract",
    "",
    `Hash: ${contract.hash}`,
    `Objective: ${contract.objective}`,
    `Test protection: ${contract.testGlobs.length > 0 ? contract.testGlobs.join(", ") : "none"}`,
    `Scope: ${contract.scopeGlobs.length > 0 ? contract.scopeGlobs.join(", ") : "unbounded"}`,
    "",
    ...contract.criteria.map((criterion) => {
      const detail = criterion.check
        ? ` check: ${criterion.check.command} (${criterion.check.expect})`
        : criterion.metric
          ? ` metric: ${criterion.metric.name} (${criterion.metric.direction})`
          : "";
      return `- ${criterion.id} [${criterion.kind}${criterion.blocking ? ", blocking" : ""}] ${criterion.statement}${detail}`;
    }),
  ];
  return lines.join("\n");
}

function directionsSection(state: ResearchState): string {
  if (state.directions.length === 0) return "";
  return [
    "## Directions",
    "",
    ...state.directions.map(
      (direction) =>
        `- ${direction.id} [${direction.status}] ${direction.title} (proxy: ${direction.proxyMetric})` +
        (direction.evidence
          ? ` evidence: ${direction.evidence.value ?? "—"} @ ${direction.evidence.outputHash.slice(0, 19)}`
          : ""),
    ),
  ].join("\n");
}

function gatesSection(state: ResearchState): string {
  const gate = state.gates.at(-1);
  if (!gate) return "";
  const failed = gate.criteria.filter((verdict) => !verdict.pass);
  return [
    "## Last Gate",
    "",
    `Verdict: ${gate.verdict} (${gate.contractHash})`,
    ...failed.map((verdict) => `- failed: ${verdict.criterionId} — ${verdict.detail}`),
  ].join("\n");
}

function attemptsSection(state: ResearchState): string {
  if (state.attempts.length === 0) return "";
  const recent = state.attempts.slice(-5);
  return [
    "## Reverted Attempts",
    "",
    ...recent.map(
      (attempt) =>
        `- #${attempt.run} ${attempt.status}: ${attempt.description} — patch: ${attempt.patchPath}`,
    ),
  ].join("\n");
}

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
      `Best     (#${best.runNumber}): ${formatMetricWithUnit(best.metric, model.metricUnit)}${formatDeltaSuffix(best.deltaPercent)}`,
    );
  }
  return lines;
}

function formatMetricWithUnit(value: number, unit: string): string {
  return `${formatPlainMetric(value)}${unit}`;
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

function nextStepSection(phase: ResearchPhase): string {
  const actions: Record<ResearchPhase, string> = {
    inactive: "Goal mode is off. Use /goal <text> to start.",
    framing: "Call frame_goal with at least two orthogonal direction cards.",
    probing: "Call probe_goal for every open direction; each probe ends kept or killed with evidence.",
    converging: "Call freeze_criteria with one primary metric and an executable check for every blocking criterion.",
    needs_init: "Call frame_goal to explore directions, or init_goal for a single clear metric.",
    needs_baseline: "Run the baseline with run_goal, then call log_goal.",
    awaiting_log: "Call log_goal for the previous run_goal result before anything else.",
    sealed: "Pick the most promising hypothesis and run the next measured run with run_goal, then log_goal. Do not stop until interrupted.",
    limit_reached: "The run limit is reached. Stop and report the best result.",
  };
  return ["## Next Step", "", actions[phase]].join("\n");
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

function formatRunLine(run: ResearchRunSummary): string {
  const head = `#${run.runNumber} ${padStatus(run.status)} ${formatPlainMetric(run.metric)}${formatDeltaSuffix(run.deltaPercent)}`;
  const parts = [head, formatDescription(run), ...formatAsiFields(run.asi)];
  return parts.filter(Boolean).join(" | ");
}

function padStatus(status: ResearchRunSummary["status"]): string {
  return status.padEnd(STATUS_WIDTH);
}

const STATUS_WIDTH = "checks_failed".length;

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
