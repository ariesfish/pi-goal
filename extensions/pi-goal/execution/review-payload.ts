import * as fs from "node:fs";
import * as path from "node:path";

import type { GateResult, GoalContract } from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { isResearchStatePath } from "../persistence/research-directory.ts";
import type { HostExec } from "../support/exec.ts";

export interface ReviewPayload {
  version: 1;
  objective: string;
  criteria: GoalContract["criteria"];
  testGlobs: string[];
  scopeGlobs: string[];
  changedPaths: string[];
  gate: GateResult | null;
  diff: string;
  diffTruncated: boolean;
  untracked: Array<Record<string, unknown>>;
}

const MAX_DIFF_BYTES = 400_000;
const MAX_UNTRACKED_BYTES = 200_000;
const MAX_UNTRACKED_FILE_BYTES = 60_000;

export async function buildReviewPayload(options: {
  pi: HostExec;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  changedPaths: string[];
}): Promise<ReviewPayload> {
  const { diff, untracked, diffTruncated } = await readCandidateChanges(options.pi, options.workDir);
  return {
    version: 1,
    objective: options.contract.objective,
    criteria: options.contract.criteria,
    testGlobs: options.contract.testGlobs,
    scopeGlobs: options.contract.scopeGlobs,
    changedPaths: options.changedPaths,
    gate: options.state.gates.at(-1) ?? null,
    diff,
    diffTruncated,
    untracked,
  };
}

async function readCandidateChanges(
  pi: HostExec,
  workDir: string,
): Promise<{ diff: string; untracked: Array<Record<string, unknown>>; diffTruncated: boolean }> {
  let diff = "";
  try {
    const result = await pi.exec("git", ["diff", "HEAD", "--binary"], { cwd: workDir, timeout: 15000 });
    diff = result.stdout;
  } catch {
    diff = "";
  }
  const diffTruncated = diff.length > MAX_DIFF_BYTES;

  const untracked: Array<Record<string, unknown>> = [];
  let total = 0;
  try {
    const status = await pi.exec("git", ["status", "--porcelain"], { cwd: workDir, timeout: 5000 });
    for (const line of status.stdout.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      const relative = line.slice(3).trim();
      if (!relative || isResearchStatePath(relative)) continue;
      if (total >= MAX_UNTRACKED_BYTES) break;
      try {
        const full = path.join(workDir, relative);
        const content = fs.readFileSync(full);
        const text = content.includes(0) ? null : content.toString("utf8").slice(0, MAX_UNTRACKED_FILE_BYTES);
        const entry: Record<string, unknown> = { path: relative };
        if (text === null) entry.binary = true;
        else {
          entry.content = text;
          entry.truncated = content.length > MAX_UNTRACKED_FILE_BYTES;
          total += Buffer.byteLength(text);
        }
        untracked.push(entry);
      } catch {
        // Unreadable untracked path: skip; the diff remains authoritative.
      }
    }
  } catch {
    // No status: review what the diff shows.
  }

  return {
    diff: diffTruncated ? diff.slice(0, MAX_DIFF_BYTES) : diff,
    untracked,
    diffTruncated,
  };
}
