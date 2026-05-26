import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

const METRIC_LINE_PREFIX = "METRIC";
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export interface ExperimentRunnerExecResult {
  code: number | null;
  killed?: boolean;
  stdout: string;
  stderr: string;
}

export interface ExperimentRunnerPiAdapter {
  exec(
    command: string,
    args: string[],
    options: { signal?: AbortSignal; timeout?: number; cwd?: string },
  ): Promise<ExperimentRunnerExecResult>;
}

export interface ExperimentRunUpdate {
  content: [{ type: "text"; text: string }];
  details: {
    phase: "running";
    elapsed: string;
    truncation?: ReturnType<typeof truncateTail>;
    fullOutputPath?: string;
  };
}

export interface RunExperimentOptions {
  command: string;
  workDir: string;
  timeoutSeconds?: number;
  checksTimeoutSeconds?: number;
  metricName: string;
  metricUnit: string;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  pi: ExperimentRunnerPiAdapter;
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

export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
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

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }
}

async function runShellCommand(options: {
  command: string;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  getTempFile: () => string;
  startedAt: number;
}): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  tempFilePath: string | undefined;
  actualTotalBytes: number;
}> {
  const { command, workDir, timeoutMs, signal, onUpdate, getTempFile, startedAt } = options;

  return new Promise((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
    let totalBytes = 0;

    let chunksGeneration = 0;
    let cachedGeneration = -1;
    let cachedText = "";

    function getBufferText(): string {
      if (cachedGeneration === chunksGeneration) return cachedText;
      cachedText = Buffer.concat(chunks).toString("utf-8");
      cachedGeneration = chunksGeneration;
      return cachedText;
    }

    const timerInterval = setInterval(() => {
      if (!onUpdate) return;
      const elapsed = formatElapsed(Date.now() - startedAt);
      const truncation = truncateTail(getBufferText(), {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      onUpdate({
        content: [{ type: "text", text: truncation.content || "" }],
        details: {
          phase: "running",
          elapsed,
          truncation: truncation.truncated ? truncation : undefined,
          fullOutputPath: tempFilePath,
        },
      });
    }, 1000);

    const handleData = (data: Buffer) => {
      totalBytes += data.length;

      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) tempFileStream.write(chunk);
      }

      if (tempFileStream) tempFileStream.write(data);

      chunks.push(data);
      chunksBytes += data.length;

      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }

      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a);
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
        }
      }

      chunksGeneration++;
    };

    if (child.stdout) child.stdout.on("data", handleData);
    if (child.stderr) child.stderr.on("data", handleData);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeoutMs);
    }

    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else {
        child.kill();
        child.once("spawn", () => { if (child.pid) killTree(child.pid); });
      }
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      resolve({
        exitCode: code,
        timedOut: processTimedOut,
        output: Buffer.concat(chunks).toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
      });
    });
  });
}

export async function runExperiment(options: RunExperimentOptions): Promise<RunExperimentResult> {
  const timeoutMs = (options.timeoutSeconds ?? 600) * 1000;
  const startedAt = Date.now();
  const getTempFile = createTempFileAllocator();

  const { exitCode, timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await runShellCommand({
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

  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;

  const checksPath = path.join(options.workDir, "goal.checks.sh");
  if (benchmarkPassed && fs.existsSync(checksPath)) {
    const checksTimeout = (options.checksTimeoutSeconds ?? 300) * 1000;
    const checksStartedAt = Date.now();
    try {
      const checksResult = await options.pi.exec("bash", [checksPath], {
        signal: options.signal,
        timeout: checksTimeout,
        cwd: options.workDir,
      });
      checksDuration = (Date.now() - checksStartedAt) / 1000;
      checksTimedOut = !!checksResult.killed;
      checksPass = checksResult.code === 0 && !checksResult.killed;
      checksOutput = `${checksResult.stdout}\n${checksResult.stderr}`.trim();
    } catch (error) {
      checksDuration = (Date.now() - checksStartedAt) / 1000;
      checksPass = false;
      checksOutput = error instanceof Error ? error.message : String(error);
    }
  }

  const passed = benchmarkPassed && (checksPass === null || checksPass);

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

  const parsedMetricMap = parseMetricLines(output);
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
    checksPass,
    checksTimedOut,
    checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
    checksDuration,
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
