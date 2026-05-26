import * as fs from "node:fs";

import { activeResearch } from "./research-directory.ts";
import { isRunResultEntry, parseJournalEntry } from "./research-journal-codec.ts";

export function readResearchJournalLines(workDir: string): string[] {
  const jsonlPath = activeResearch(workDir).paths.journal;
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
