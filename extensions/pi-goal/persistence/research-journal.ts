import * as fs from "node:fs";

import {
  cloneResearchState,
  type ResearchState,
  type RunResult,
} from "../domain/research-state.ts";
import type { Direction, GoalContract, ProbeRecord } from "../domain/goal-contract.ts";
import { activeResearch, ensureActiveResearch } from "./research-directory.ts";
import { replayJournal } from "./research-state-hydration.ts";
import {
  isRunResultEntry,
  parseJournalEntry,
  type ParsedJournal,
} from "./research-journal-codec.ts";

export interface ExperimentConfigJournalEntry {
  type: "config";
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The journal is append-only and every append goes through this module, so a
 * replayed snapshot stays valid until the file's identity changes. Without
 * this, a per-turn caller re-parses the whole journal on every turn.
 */
const snapshotCache = new Map<string, { key: string; snapshot: ParsedJournal }>();

export function readJournalSnapshot(workDir: string): ParsedJournal | null {
  const journalPath = activeResearch(workDir).paths.journal;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(journalPath);
  } catch {
    return null;
  }

  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = snapshotCache.get(journalPath);
  if (cached && cached.key === key) return cached.snapshot;

  const parsed = replayJournal(fs.readFileSync(journalPath, "utf-8"));
  snapshotCache.set(journalPath, { key, snapshot: parsed });
  return parsed;
}

function readResearchJournalContent(workDir: string): string {
  const journalPath = activeResearch(workDir).paths.journal;
  if (!fs.existsSync(journalPath)) return "";
  return fs.readFileSync(journalPath, "utf-8");
}

function readResearchJournalLines(workDir: string): string[] {
  return readResearchJournalContent(workDir).split("\n").filter(Boolean);
}

export function hydrateResearchStateFromJournalFile(state: ResearchState, workDir: string): boolean {
  const snapshot = readJournalSnapshot(workDir);
  if (!snapshot) return false;
  Object.assign(state, cloneResearchState(snapshot.state));
  return snapshot.state.results.length > 0;
}

export function readLastRunResult(workDir: string): Record<string, unknown> | null {
  const lines = readResearchJournalLines(workDir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJournalEntry(lines[i]);
    if (isRunResultEntry(entry)) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The only write path: one append, one cache invalidation. */
function appendLine(workDir: string, line: string): string | null {
  try {
    const journalPath = ensureActiveResearch(workDir).paths.journal;
    fs.appendFileSync(journalPath, line + "\n");
    snapshotCache.delete(journalPath);
    return null;
  } catch (error) {
    return journalWriteError(error);
  }
}

function journalWriteError(error: unknown): string {
  return `⚠️ Failed to write goal.jsonl: ${error instanceof Error ? error.message : String(error)}`;
}

/** Remove the journal of the active research (the `/goal clear` action). */
export function deleteJournal(workDir: string): { deleted: boolean; error: string | null } {
  const journalPath = activeResearch(workDir).paths.journal;
  if (!fs.existsSync(journalPath)) return { deleted: false, error: null };
  try {
    fs.unlinkSync(journalPath);
    snapshotCache.delete(journalPath);
    return { deleted: true, error: null };
  } catch (error) {
    return { deleted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function appendJournalEntry(workDir: string, entry: object): string | null {
  return appendLine(workDir, JSON.stringify(entry));
}

export function appendExperimentConfigToJournal(workDir: string, state: ResearchState): string | null {
  return appendJournalEntry(workDir, experimentConfigJournalEntry(state));
}

export function appendRunResultToJournal(workDir: string, entry: Record<string, unknown>): string | null {
  return appendJournalEntry(workDir, entry);
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

export function experimentConfigJournalEntry(state: ResearchState): ExperimentConfigJournalEntry {
  return {
    type: "config",
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    bestDirection: state.bestDirection,
  };
}

export function runResultJournalEntry(runNumber: number, runResult: RunResult): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    run: runNumber,
    ...runResult,
  };
  if (!runResult.asi) delete entry.asi;
  return entry;
}

export function contractJournalEntry(contract: GoalContract): Record<string, unknown> {
  return { type: "contract", contract };
}

export function directionJournalEntry(direction: Direction): Record<string, unknown> {
  return { type: "direction", direction };
}

export function probeJournalEntry(probe: ProbeRecord): Record<string, unknown> {
  return { type: "probe", probe };
}

export function policyJournalEntry(
  allowTestEdits: boolean,
  allowBenchmarkEdits = false,
): Record<string, unknown> {
  return { type: "policy", policy: { allowTestEdits, allowBenchmarkEdits, at: Date.now() } };
}
