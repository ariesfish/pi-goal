import * as fs from "node:fs";

import type { ResearchState, RunResult } from "../domain/research-state.ts";
import { activeResearch, ensureActiveResearch } from "./research-directory.ts";
import {
  hydrateResearchStateFromJournal,
  researchStateFromJournal,
} from "./research-state-hydration.ts";
import {
  isRunResultEntry,
  parseJournalEntry,
  parseResearchJournalModel,
  type ResearchJournalModel,
} from "./research-journal-codec.ts";

export interface ExperimentConfigJournalEntry {
  type: "config";
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
}

export function readResearchJournalContent(workDir: string): string {
  const journalPath = activeResearch(workDir).paths.journal;
  if (!fs.existsSync(journalPath)) return "";
  return fs.readFileSync(journalPath, "utf-8");
}

export function readResearchJournalLines(workDir: string): string[] {
  return readResearchJournalContent(workDir).split("\n").filter(Boolean);
}

export function readResearchJournalModel(workDir: string): ResearchJournalModel {
  return parseResearchJournalModel(readResearchJournalContent(workDir));
}

export function readResearchStateFromJournal(workDir: string): ResearchState {
  return researchStateFromJournal(readResearchJournalContent(workDir));
}

export function hydrateResearchStateFromJournalFile(state: ResearchState, workDir: string): boolean {
  const journalPath = activeResearch(workDir).paths.journal;
  if (!fs.existsSync(journalPath)) return false;
  return hydrateResearchStateFromJournal(state, fs.readFileSync(journalPath, "utf-8"));
}

export function readLastRunResult(workDir: string): Record<string, unknown> | null {
  const lines = readResearchJournalLines(workDir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJournalEntry(lines[i]);
    if (isRunResultEntry(entry)) return entry;
  }
  return null;
}

export function experimentConfigJournalEntry(state: ResearchState): ExperimentConfigJournalEntry {
  return {
    type: "config",
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    bestDirection: state.bestDirection,
  };
}

export function appendExperimentConfigToJournal(workDir: string, state: ResearchState): string | null {
  try {
    const journalPath = ensureActiveResearch(workDir).paths.journal;
    fs.appendFileSync(journalPath, JSON.stringify(experimentConfigJournalEntry(state)) + "\n");
    return null;
  } catch (error) {
    return journalWriteError(error);
  }
}

export function runResultJournalEntry(runNumber: number, runResult: RunResult): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    run: runNumber,
    ...runResult,
  };
  if (!runResult.asi) delete entry.asi;
  return entry;
}

export function appendRunResultToJournal(workDir: string, entry: Record<string, unknown>): string | null {
  try {
    fs.appendFileSync(ensureActiveResearch(workDir).paths.journal, JSON.stringify(entry) + "\n");
    return null;
  } catch (error) {
    return journalWriteError(error);
  }
}

function journalWriteError(error: unknown): string {
  return `⚠️ Failed to write goal.jsonl: ${error instanceof Error ? error.message : String(error)}`;
}
