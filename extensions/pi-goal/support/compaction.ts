/**
 * Deterministic compaction summary for research.
 *
 * Replaces the default LLM-generated summary with a synthesized view of
 * persisted state — experiment rules, ideas backlog, and recent runs.
 * Everything that matters between iterations already lives on disk, so we
 * skip the LLM call entirely and keep the summary lossless on what counts.
 *
 * This module owns the filesystem half; `compaction-summary.ts` owns the text.
 */

import * as fs from "node:fs";

import { researchStateFromJournal } from "../persistence/research-state-hydration.ts";
import type { ResearchPhase } from "../protocol/research-phase.ts";
import { activeResearch } from "../persistence/research-directory.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { renderCompactionSummary, type CompactionInput } from "./compaction-summary.ts";

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

/** Read everything the summary needs. Returns the whole input as one value. */
export function readCompactionInput(
  paths: ResearchSummaryPaths,
  phase: ResearchPhase,
): CompactionInput {
  return {
    state: researchStateFromJournal(readFileOrEmpty(paths.jsonlPath)),
    phase,
    rulesText: readTrimmedFile(paths.mdPath),
    ideasText: readTrimmedFile(paths.ideasPath),
  };
}

/** Build the full compaction summary text from persisted research state. */
export function buildResearchCompactionSummary(
  paths: ResearchSummaryPaths,
  phase: ResearchPhase = "sealed",
): string {
  return renderCompactionSummary(readCompactionInput(paths, phase));
}

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
