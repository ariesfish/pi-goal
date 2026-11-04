import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ReviewFinding } from "../domain/goal-contract.ts";
import { reviewResultFrom } from "../persistence/research-journal-codec.ts";
import type { ReviewerConfig } from "../persistence/goal-config.ts";
import type { ReviewPayload } from "./review-payload.ts";

export interface PiCommand {
  command: string;
  args: string[];
}

export interface ReviewAdapter {
  readonly label: string;
  review(payload: ReviewPayload): Promise<ReviewFinding[]>;
}

export function createReviewAdapter(options: {
  reviewer: ReviewerConfig;
  workDir: string;
  piCommand?: PiCommand;
}): ReviewAdapter {
  return options.reviewer.kind === "pi"
    ? piAdapter(options)
    : commandAdapter(options);
}

function piAdapter(options: {
  reviewer: ReviewerConfig;
  workDir: string;
  piCommand?: PiCommand;
}): ReviewAdapter {
  const model = options.reviewer.model;
  if (!model) throw new Error('reviewer.model is required for kind "pi".');
  return {
    label: `pi:${model}`,
    async review(payload) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-review-"));
      try {
        fs.writeFileSync(path.join(dir, "payload.json"), JSON.stringify(payload));
        const invocation = options.piCommand ?? piInvocation();
        const prompt = [
          "You are a blind code reviewer. Read payload.json in the current directory.",
          'Return ONLY one JSON object: {"findings":[{"id":"F1","severity":"blocking"|"advisory","claim":"...","file":"...","line":123,"repro":{"kind":"command"|"test","payload":"..."}}]}.',
          "Judge only what payload.json proves: the diff, untracked files, the frozen criteria, and the last gate.",
          "A blocking finding MUST include a minimal repro command that fails on the current code and passes after the fix.",
          "If you cannot produce a failing repro, use severity \"advisory\".",
          "No prose and no markdown fences.",
        ].join("\n");
        const run = await runProcess({
          command: invocation.command,
          args: [
            ...invocation.args,
            "-p",
            "--mode",
            "text",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-mcp",
            "--tools",
            "read",
            "--model",
            model,
            ...(options.reviewer.thinking ? ["--thinking", options.reviewer.thinking] : []),
            prompt,
          ],
          cwd: dir,
          timeoutMs: (options.reviewer.timeoutSeconds ?? 300) * 1000,
        });
        if (run.timedOut || run.code !== 0) {
          throw new Error(
            `Pi reviewer failed (exit ${run.code ?? "?"}${run.timedOut ? ", timed out" : ""}): ${tail(run.stderr || run.stdout)}`,
          );
        }
        return parseFindings(run.stdout, `pi:${model}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function commandAdapter(options: {
  reviewer: ReviewerConfig;
  workDir: string;
}): ReviewAdapter {
  const command = options.reviewer.command;
  if (!command) throw new Error('reviewer.command is required for kind "command".');
  return {
    label: command,
    async review(payload) {
      const run = await runProcessWithStdin({
        command,
        args: options.reviewer.args ?? [],
        input: JSON.stringify(payload),
        cwd: options.workDir,
        timeoutMs: (options.reviewer.timeoutSeconds ?? 180) * 1000,
      });
      if (run.timedOut || run.code !== 0) {
        throw new Error(
          `Reviewer command failed (exit ${run.code ?? "?"}${run.timedOut ? ", timed out" : ""}): ${tail(run.stderr || run.stdout)}`,
        );
      }
      return parseFindings(run.stdout, command);
    },
  };
}

function parseFindings(stdout: string, reviewer: string): ReviewFinding[] {
  const text = stripFences(stdout.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidateText = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateText);
  } catch {
    throw new Error(`Reviewer output is not JSON: ${tail(stdout)}`);
  }

  const candidate = Array.isArray(parsed)
    ? { reviewer, at: Date.now(), findings: parsed }
    : parsed && typeof parsed === "object"
      ? { reviewer, at: Date.now(), findings: (parsed as { findings?: unknown }).findings ?? [] }
      : null;
  const review = candidate ? reviewResultFrom(candidate) : null;
  if (!review) throw new Error(`Reviewer output does not match the findings schema: ${tail(stdout)}`);
  return review.findings;
}

function piInvocation(): PiCommand {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script] };
  }
  const exe = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(exe)
    ? { command: "pi", args: [] }
    : { command: process.execPath, args: [] };
}

function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return runChild({ ...options, stdin: "ignore", input: undefined });
}

function runProcessWithStdin(options: {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return runChild({ ...options, stdin: "pipe" });
}

function runChild(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin: "ignore" | "pipe";
  input?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: [options.stdin, "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    if (child.stdin) child.stdin.on("error", () => { /* reviewer exited before reading stdin */ });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (child.stdin && options.input !== undefined) {
      try {
        child.stdin.end(options.input);
      } catch {
        // The close handler reports the failure.
      }
    }
  });
}

function stripFences(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1] : text;
}

function tail(text: string): string {
  return text.split("\n").slice(-8).join("\n").slice(-1000);
}
