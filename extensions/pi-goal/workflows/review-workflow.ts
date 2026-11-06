import type {
  GoalContract,
  ReviewFinding,
  ReviewResult,
} from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import {
  buildReviewPayload,
  type ReviewExecAdapter,
} from "../execution/review-payload.ts";
import { createReviewAdapter, type PiCommand } from "../execution/review-adapter.ts";
import { appendJournalEntry } from "../persistence/research-journal.ts";
import { checkResearchWorkspace } from "../workspace/research-workspace.ts";
import type { ReviewerConfig } from "../persistence/goal-config.ts";

export interface ReviewWorkflowOptions {
  pi: ReviewExecAdapter;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  reviewer: ReviewerConfig;
  changedPaths: string[];
  /** Test seam: replace the pi binary invocation used by kind "pi". */
  piCommand?: PiCommand;
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

export interface RecordReviewOptions {
  pi: ReviewExecAdapter;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  reviewer: ReviewerConfig;
  /** Reuse a workspace read the caller already made; otherwise one is taken. */
  changedPaths?: string[];
}

export type ReviewRecording =
  | { recorded: true; result: ReviewWorkflowResult }
  | { recorded: false; text: string };

export async function runReview(options: ReviewWorkflowOptions): Promise<ReviewWorkflowResult> {
  const payload = await buildReviewPayload({
    pi: options.pi,
    workDir: options.workDir,
    contract: options.contract,
    state: options.state,
    changedPaths: options.changedPaths,
  });
  const adapter = createReviewAdapter({
    reviewer: options.reviewer,
    workDir: options.workDir,
    piCommand: options.piCommand,
  });
  const findings = await adapter.review(payload);
  const verified: ReviewFinding[] = [];
  for (const finding of findings) {
    verified.push(await verifyFinding(finding, options.workDir, options.pi));
  }

  const review: ReviewResult = {
    reviewer: adapter.label,
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

/**
 * Run the reviewer, append its findings to the Research Journal, and keep the
 * Review Result on the in-memory state. The caller keeps the policy: which
 * reviewer to use, and whether a failure blocks or stays advisory.
 */
export async function recordReview(options: RecordReviewOptions): Promise<ReviewRecording> {
  let changedPaths = options.changedPaths;
  if (!changedPaths) {
    const workspace = await checkResearchWorkspace(options.pi, options.workDir);
    if (workspace.error) {
      return { recorded: false, text: `❌ Reviewer could not read the workspace: ${workspace.error}` };
    }
    changedPaths = workspace.userPaths;
  }

  const result = await runReview({
    pi: options.pi,
    workDir: options.workDir,
    contract: options.contract,
    state: options.state,
    reviewer: options.reviewer,
    changedPaths,
  });

  const journalError = appendJournalEntry(options.workDir, {
    type: "review",
    review: result.review,
  });
  if (journalError) return { recorded: false, text: journalError };

  options.state.reviews.push(result.review);
  return { recorded: true, result };
}

async function verifyFinding(
  finding: ReviewFinding,
  workDir: string,
  pi: ReviewExecAdapter,
): Promise<ReviewFinding> {
  if (!finding.repro) return { ...finding, reproduced: false };

  try {
    const result = await pi.exec("bash", ["-c", finding.repro.payload], {
      cwd: workDir,
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

function tail(text: string): string {
  return text.split("\n").slice(-8).join("\n").slice(-1000);
}
