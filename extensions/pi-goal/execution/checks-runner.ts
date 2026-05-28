import * as fs from "node:fs";
import * as path from "node:path";

import type { ExperimentRunnerPiAdapter } from "./experiment-runner.ts";

export interface ChecksRunResult {
  pass: boolean | null;
  timedOut: boolean;
  output: string;
  durationSeconds: number;
}

export async function runChecks(options: {
  workDir: string;
  benchmarkPassed: boolean;
  checksTimeoutSeconds?: number;
  signal?: AbortSignal;
  pi: ExperimentRunnerPiAdapter;
}): Promise<ChecksRunResult> {
  let pass: boolean | null = null;
  let timedOut = false;
  let output = "";
  let durationSeconds = 0;

  const checksPath = path.join(options.workDir, "goal.checks.sh");
  if (!options.benchmarkPassed || !fs.existsSync(checksPath)) {
    return { pass, timedOut, output, durationSeconds };
  }

  const timeout = (options.checksTimeoutSeconds ?? 300) * 1000;
  const startedAt = Date.now();
  try {
    const result = await options.pi.exec("bash", [checksPath], {
      signal: options.signal,
      timeout,
      cwd: options.workDir,
    });
    durationSeconds = (Date.now() - startedAt) / 1000;
    timedOut = !!result.killed;
    pass = result.code === 0 && !result.killed;
    output = `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    durationSeconds = (Date.now() - startedAt) / 1000;
    pass = false;
    output = error instanceof Error ? error.message : String(error);
  }

  return { pass, timedOut, output, durationSeconds };
}
