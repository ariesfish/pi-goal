import { spawn, type ChildProcess } from "node:child_process";

import {
  createOutputCapture,
  type CapturedOutput,
  type ExperimentRunUpdate,
  type OutputStream,
} from "./output-capture.ts";

export interface ShellCommandResult extends CapturedOutput {
  exitCode: number | null;
  timedOut: boolean;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Never fall back to a reaped PID that another process could have acquired.
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

export async function runShellCommand(options: {
  command: string;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  getTempFile: () => string;
  startedAt: number;
}): Promise<ShellCommandResult> {
  const { command, workDir, timeoutMs, signal, onUpdate, getTempFile, startedAt } = options;
  if (signal?.aborted) throw new Error("aborted");

  return new Promise((resolve, reject) => {
    let processTimedOut = false;
    let terminating = false;
    let completed = false;
    let executionError: unknown;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("bash", ["-c", command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = createOutputCapture({ getTempFile });

    function terminate(): void {
      if (terminating) return;
      terminating = true;
      const stop = () => {
        if (!child.pid) return;
        killTree(child);
        killHandle = setTimeout(() => {
          killTree(child, "SIGKILL");
          // Escaped descendants must not hold the caller open through inherited pipes.
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000);
      };
      if (child.pid) stop();
      else child.once("spawn", stop);
    }

    function handleData(data: Buffer, stream: OutputStream): void {
      if (executionError) return;
      try {
        capture.handleData(data, stream);
      } catch (error) {
        executionError = error;
        terminate();
      }
    }
    child.stdout.on("data", (data: Buffer) => handleData(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => handleData(data, "stderr"));

    const timerInterval = onUpdate ? setInterval(() => {
      try {
        onUpdate(capture.renderUpdate(Date.now() - startedAt));
      } catch (error) {
        executionError = error;
        terminate();
      }
    }, 1000) : undefined;

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        terminate();
      }, timeoutMs);
    }
    const onAbort = () => terminate();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    function complete(code: number | null, error?: Error): void {
      if (completed) return;
      completed = true;
      clearInterval(timerInterval);
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      signal?.removeEventListener("abort", onAbort);
      // close can fire while descendants with redirected output are still running.
      if (terminating) killTree(child, "SIGKILL");

      void capture.finish().then((output) => {
        if (error || executionError) {
          reject(error ?? executionError);
        } else if (signal?.aborted) {
          reject(new Error("aborted"));
        } else {
          resolve({ ...output, exitCode: code, timedOut: processTimedOut });
        }
      }, reject);
    }

    child.once("error", (error) => complete(null, error));
    child.once("close", (code) => complete(code));
  });
}
