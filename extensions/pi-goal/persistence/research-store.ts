import * as fs from "node:fs";
import * as path from "node:path";

import type { ResearchSnapshot } from "../execution/hooks.ts";
import {
  parseJournalEntry,
  isRunResultEntry,
  reconstructResearchStateFromJournal,
} from "./research-journal.ts";
import {
  computeConfidence,
  findBaselineMetric,
  findBestMetric,
  type ResearchState,
} from "../domain/research-state.ts";
import {
  activeResearchPath,
  ensureActiveResearchDirectory,
  sanitizeResearchId,
} from "./research-directory.ts";
import { researchJournalPath } from "./research-paths.ts";

export function readResearchJournalLines(workDir: string): string[] {
  const jsonlPath = researchJournalPath(workDir);
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
}

export function readLastRunResult(workDir: string): Record<string, unknown> | null {
  const lines = readResearchJournalLines(workDir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJournalEntry(lines[i]);
    if (isRunResultEntry(entry)) return entry;
  }
  return null;
}

export function hydrateResearchStateFromJournal(state: ResearchState, jsonlContent: string): boolean {
  const reconstructed = reconstructResearchStateFromJournal(jsonlContent);
  state.name = reconstructed.name;
  state.metricName = reconstructed.metricName;
  state.metricUnit = reconstructed.metricUnit;
  state.bestDirection = reconstructed.bestDirection;
  state.currentExperimentIndex = reconstructed.currentExperimentIndex;
  state.results = reconstructed.results.map((result) => ({
    ...result,
    metrics: { ...result.metrics },
  }));
  state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

  if (state.results.length === 0) return false;
  state.bestMetric = findBaselineMetric(state.results, state.currentExperimentIndex);
  state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
  return true;
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

export function selectActiveResearch(projectDir: string, requestedResearchId: string): string {
  const researchId = sanitizeResearchId(requestedResearchId);
  fs.mkdirSync(path.dirname(activeResearchPath(projectDir)), { recursive: true });
  fs.writeFileSync(activeResearchPath(projectDir), researchId + "\n");
  ensureActiveResearchDirectory(projectDir);
  return researchId;
}
