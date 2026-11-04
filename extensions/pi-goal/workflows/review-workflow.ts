import { spawn } from "node:child_process";

import type {
  GoalContract,
  ReviewFinding,
  ReviewResult,
} from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { reviewResultFrom } from "../persistence/research-journal-codec.ts";
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

export async function runReview(options: ReviewWorkflowOptions): Promise<ReviewWorkflowResult> {
  const payload = {
    version: 1,
    objective: options.contract.objective,
    criteria: options.contract.criteria,
    testGlobs: options.contract.testGlobs,
    scopeGlobs: options.contract.scopeGlobs,
    changedPaths: options.changedPaths,
    gate: options.state.gates.at(-1) ?? null,
    diff: await readDiff(options.pi, options.workDir),
  };

  const run = await runReviewerCommand({
    command: options.reviewer.command,
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

  const findings = parseFindings(run.stdout, options.reviewer.command);
  const verified: ReviewFinding[] = [];
  for (const finding of findings) {
    verified.push(await verifyFinding(finding, options));
  }

  const review: ReviewResult = {
    reviewer: options.reviewer.command,
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

function parseFindings(stdout: string, reviewer: string): ReviewFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
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

async function readDiff(pi: ReviewExecAdapter, workDir: string): Promise<string> {
  try {
    const result = await pi.exec("git", ["diff", "HEAD", "--binary"], { cwd: workDir, timeout: 15000 });
    return result.stdout.slice(0, 400_000);
  } catch {
    return "";
  }
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
    child.stdin.end(options.input);
  });
}

function tail(text: string): string {
  return text.split("\n").slice(-8).join("\n").slice(-1000);
}
