import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  GoalContract,
  ReviewFinding,
  ReviewResult,
} from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { reviewResultFrom } from "../persistence/research-journal-codec.ts";
import { isResearchStatePath } from "../persistence/research-directory.ts";
import type { ReviewerConfig } from "../persistence/goal-config.ts";

export interface ReviewExecAdapter {
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface ReviewWorkflowOptions {
  pi: ReviewExecAdapter;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  reviewer: ReviewerConfig;
  changedPaths: string[];
  /** Test seam: replace the pi binary invocation used by kind "pi". */
  piCommand?: { command: string; args: string[] };
}

export interface ReviewPrecision {
  blockingFindings: number;
  reproducedFindings: number;
  rate: number | null;
}

export interface ReviewWorkflowResult {
  review: ReviewResult;
  deniedKeep: boolean;
  precision: ReviewPrecision;
  text: string;
}

const MAX_DIFF_BYTES = 400_000;
const MAX_UNTRACKED_BYTES = 200_000;
const MAX_UNTRACKED_FILE_BYTES = 60_000;

export async function runReview(options: ReviewWorkflowOptions): Promise<ReviewWorkflowResult> {
  const { diff, untracked, diffTruncated } = await readCandidateChanges(options.pi, options.workDir);
  const payload = {
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

  const findings = options.reviewer.kind === "pi"
    ? await runPiReviewer(payload, options)
    : await runCommandReviewer(payload, options);
  const verified: ReviewFinding[] = [];
  for (const finding of findings) {
    verified.push(await verifyFinding(finding, options));
  }

  const review: ReviewResult = {
    reviewer: options.reviewer.kind === "pi"
      ? `pi:${options.reviewer.model}`
      : options.reviewer.command ?? "command",
    at: Date.now(),
    findings: verified,
  };
  const precision = measurePrecision([...options.state.reviews, review]);
  const deniedKeep =
    options.reviewer.blocking === true &&
    verified.some((finding) => finding.severity === "blocking" && finding.reproduced);

  return {
    review,
    deniedKeep,
    precision,
    text: summarize(review, precision, options.reviewer.blocking === true),
  };
}

async function runCommandReviewer(
  payload: Record<string, unknown>,
  options: ReviewWorkflowOptions,
): Promise<ReviewFinding[]> {
  const command = options.reviewer.command;
  if (!command) throw new Error('reviewer.command is required for kind "command".');
  const run = await runReviewerCommand({
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
}

async function runPiReviewer(
  payload: Record<string, unknown>,
  options: ReviewWorkflowOptions,
): Promise<ReviewFinding[]> {
  const model = options.reviewer.model;
  if (!model) throw new Error('reviewer.model is required for kind "pi".');

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

    const args = [
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
    ];
    const run = await runProcess({
      command: invocation.command,
      args,
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

async function verifyFinding(
  finding: ReviewFinding,
  options: ReviewWorkflowOptions,
): Promise<ReviewFinding> {
  if (!finding.repro) return { ...finding, reproduced: false };

  try {
    const result = await options.pi.exec("bash", ["-c", finding.repro.payload], {
      cwd: options.workDir,
      timeout: 120_000,
    });
    const reproduced = result.code !== 0;
    return {
      ...finding,
      reproduced,
      detail: reproduced
        ? `repro failed as expected (exit ${result.code}): ${tail(result.stdout + result.stderr)}`
        : `repro passed; finding not reproduced: ${tail(result.stdout + result.stderr)}`,
    };
  } catch (error) {
    return {
      ...finding,
      reproduced: false,
      detail: `repro could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function measurePrecision(reviews: ReviewResult[]): ReviewPrecision {
  let blockingFindings = 0;
  let reproducedFindings = 0;
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.severity !== "blocking") continue;
      blockingFindings++;
      if (finding.reproduced) reproducedFindings++;
    }
  }
  return {
    blockingFindings,
    reproducedFindings,
    rate: blockingFindings === 0 ? null : reproducedFindings / blockingFindings,
  };
}

function summarize(review: ReviewResult, precision: ReviewPrecision, blocking: boolean): string {
  const lines = [
    `Review by ${review.reviewer}: ${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}.`,
    ...review.findings.map(
      (finding) =>
        `- ${finding.id} [${finding.severity}${finding.reproduced ? ", reproduced" : ", not reproduced"}] ${finding.claim}`,
    ),
    precision.rate === null
      ? "Precision: no blocking findings yet."
      : `Precision: ${precision.reproducedFindings}/${precision.blockingFindings} blocking findings reproduced.`,
    blocking
      ? "Reviewer blocking is ON: a reproduced blocking finding denies keep."
      : "Reviewer blocking is OFF: findings are advisory.",
  ];
  return lines.join("\n");
}

async function readCandidateChanges(
  pi: ReviewExecAdapter,
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

function piInvocation(): { command: string; args: string[] } {
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
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function runReviewerCommand(options: {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdin.on("error", () => { /* reviewer exited before reading stdin */ });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    try {
      child.stdin.end(options.input);
    } catch {
      // The close handler reports the failure.
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
