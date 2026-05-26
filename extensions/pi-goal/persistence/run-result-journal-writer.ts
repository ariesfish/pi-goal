import * as fs from "node:fs";

import { activeResearch } from "./research-directory.ts";
import type { RunResult } from "../domain/research-state.ts";

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
    fs.appendFileSync(activeResearch(workDir).paths.journal, JSON.stringify(entry) + "\n");
    return null;
  } catch (error) {
    return `⚠️ Failed to write goal.jsonl: ${error instanceof Error ? error.message : String(error)}`;
  }
}
