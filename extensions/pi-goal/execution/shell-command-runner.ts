import { spawn } from "node:child_process";

import { createOutputCapture } from "./output-capture.ts";
import type { ExperimentRunUpdate } from "./experiment-runner.ts";

export interface ShellCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  tempFilePath: string | undefined;
  actualTotalBytes: number;
}

export function killTree(pid: number): void {
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

  return new Promise((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = createOutputCapture({ getTempFile });

    const timerInterval = setInterval(() => {
      if (!onUpdate) return;
      onUpdate(capture.renderUpdate(Date.now() - startedAt));
    }, 1000);

    if (child.stdout) child.stdout.on("data", capture.handleData);
    if (child.stderr) child.stderr.on("data", capture.handleData);

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
      capture.finish();
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      capture.finish();

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      resolve({
        exitCode: code,
        timedOut: processTimedOut,
        output: capture.output(),
        tempFilePath: capture.tempFilePath(),
        actualTotalBytes: capture.totalBytes(),
      });
    });
  });
}
