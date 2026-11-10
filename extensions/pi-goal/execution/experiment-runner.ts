import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import type { HostExec } from "../support/exec.ts";
import { runChecks } from "./checks-runner.ts";
import { runShellCommand } from "./shell-command-runner.ts";
import type { ExperimentRunUpdate } from "./output-capture.ts";

export { parseMetricLines } from "./metric-parser.ts";
export { formatElapsed, type ExperimentRunUpdate } from "./output-capture.ts";

export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

export interface RunExperimentOptions {
  command: string;
  workDir: string;
  timeoutSeconds?: number;
  checksTimeoutSeconds?: number;
  metricName: string;
  metricUnit: string;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  pi: HostExec;
}

export interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  parsedMetrics: Record<string, number> | null;
  parsedPrimary: number | null;
  metricName: string;
  metricUnit: string;
}

export interface RunExperimentResult {
  details: RunDetails;
  llmOutput: string;
  truncation?: ReturnType<typeof truncateTail>;
  fullOutputPath?: string;
}

export function isGoalShCommand(command: string): boolean {
  let cmd = command.trim();

  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?goal\.sh(?:\s|$)/.test(cmd);
}

function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

export async function runExperiment(options: RunExperimentOptions): Promise<RunExperimentResult> {
  const timeoutMs = (options.timeoutSeconds ?? 600) * 1000;
  const startedAt = Date.now();
  const getTempFile = createTempFileAllocator();

  const { exitCode, timedOut, output, tempFilePath: streamTempFile, actualTotalBytes, metrics: parsedMetricMap } = await runShellCommand({
    command: options.command,
    workDir: options.workDir,
    timeoutMs,
    signal: options.signal,
    onUpdate: options.onUpdate,
    getTempFile,
    startedAt,
  });

  const durationSeconds = (Date.now() - startedAt) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  const checks = await runChecks({
    workDir: options.workDir,
    benchmarkPassed,
    checksTimeoutSeconds: options.checksTimeoutSeconds,
    signal: options.signal,
    pi: options.pi,
  });

  const passed = benchmarkPassed && (checks.pass === null || checks.pass);

  let fullOutputPath: string | undefined = streamTempFile;
  const totalLines = output.split("\n").length;
  if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
    fullOutputPath = getTempFile();
    fs.writeFileSync(fullOutputPath, output);
  }

  const displayTruncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const llmTruncation = truncateTail(output, {
    maxLines: EXPERIMENT_MAX_LINES,
    maxBytes: EXPERIMENT_MAX_BYTES,
  });

  const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
  const parsedPrimary = parsedMetricMap.get(options.metricName) ?? null;

  const details: RunDetails = {
    command: options.command,
    exitCode,
    durationSeconds,
    passed,
    crashed: !passed,
    timedOut,
    tailOutput: displayTruncation.content,
    checksPass: checks.pass,
    checksTimedOut: checks.timedOut,
    checksOutput: checks.output.split("\n").slice(-80).join("\n"),
    checksDuration: checks.durationSeconds,
    parsedMetrics,
    parsedPrimary,
    metricName: options.metricName,
    metricUnit: options.metricUnit,
  };

  return {
    details,
    llmOutput: llmTruncation.content,
    truncation: llmTruncation.truncated ? llmTruncation : undefined,
    fullOutputPath,
  };
}
