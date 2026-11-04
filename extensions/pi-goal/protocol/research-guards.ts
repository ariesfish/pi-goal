import type { RunResult } from "../domain/research-state.ts";

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
export const DEFAULT_NO_PROGRESS_ROUNDS = 8;

export function countConsecutiveFailures(results: RunResult[]): number {
  let count = 0;
  for (let index = results.length - 1; index >= 0; index--) {
    const status = results[index].status;
    if (status === "discard" || status === "crash" || status === "checks_failed") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function roundsSinceLastKeep(
  results: RunResult[],
  experimentIndex: number,
): number {
  const runs = results.filter((result) => result.experimentIndex === experimentIndex);
  let rounds = 0;
  for (let index = runs.length - 1; index >= 0; index--) {
    if (runs[index].status === "keep") break;
    rounds++;
  }
  return rounds;
}

export function noProgressStopReason(
  results: RunResult[],
  experimentIndex: number,
  limit = DEFAULT_NO_PROGRESS_ROUNDS,
): string | null {
  if (roundsSinceLastKeep(results, experimentIndex) < limit) return null;
  return `No progress: ${limit} rounds without a kept improvement. Stopping so you can change the approach.`;
}

export function failureStopReason(
  results: RunResult[],
  limit = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): string | null {
  const failures = countConsecutiveFailures(results);
  if (failures < limit) return null;
  return `Stopped after ${failures} consecutive discards or crashes. Inspect the attempt patches and change the approach.`;
}
