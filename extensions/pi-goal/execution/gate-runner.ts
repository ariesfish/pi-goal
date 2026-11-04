import {
  type Criterion,
  type CriterionVerdict,
  type GateResult,
  type GoalContract,
} from "../domain/goal-contract.ts";
import { currentRuns, type ResearchState } from "../domain/research-state.ts";

export interface GateExecAdapter {
  exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface GateOptions {
  pi: GateExecAdapter;
  workDir: string;
  contract: GoalContract;
  state: ResearchState;
  metric: number;
  changedPaths: string[];
  forceKeep?: boolean;
}

export function matchGlob(filePath: string, glob: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(normalizedGlob).test(normalizedPath);
}

export async function runGate(options: GateOptions): Promise<GateResult> {
  const verdicts: CriterionVerdict[] = [];

  for (const criterion of options.contract.criteria) {
    verdicts.push(await evaluateCriterion(criterion, options));
  }

  verdicts.push(...evaluateChangedPaths(options));

  const failed = verdicts.some((verdict) => verdict.blocking && !verdict.pass);
  return {
    verdict: failed ? "fail" : "pass",
    contractHash: options.contract.hash,
    checkedAt: Date.now(),
    criteria: verdicts,
  };
}

export function formatGateFailure(gate: GateResult): string {
  const failed = gate.criteria.filter((verdict) => !verdict.pass);
  return [
    "❌ Gate failed — do not keep this run.",
    ...failed.map(
      (verdict) =>
        `- ${verdict.criterionId}${verdict.blocking ? "" : " (advisory)"}: ${verdict.detail}`,
    ),
    "Log the attempt as status: discard with the failure in ASI, or fix the failures and rerun.",
  ].join("\n");
}

export function formatGateSummary(gate: GateResult): string {
  const passed = gate.criteria.filter((verdict) => verdict.pass).length;
  return `Gate ${gate.verdict}: ${passed}/${gate.criteria.length} criteria pass (${gate.contractHash}).`;
}

export function gateJournalEntry(gate: GateResult): Record<string, unknown> {
  return { type: "gate", gate };
}

async function evaluateCriterion(
  criterion: Criterion,
  options: GateOptions,
): Promise<CriterionVerdict> {
  if (criterion.kind === "metric") {
    return evaluateMetricCriterion(criterion, options);
  }
  if (criterion.kind === "manual") {
    return {
      criterionId: criterion.id,
      pass: true,
      blocking: false,
      detail: "manual judgment — advisory only",
    };
  }
  if (!criterion.check) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: "no executable check configured",
    };
  }
  return evaluateCommandCriterion(criterion, options);
}

function evaluateMetricCriterion(criterion: Criterion, options: GateOptions): CriterionVerdict {
  const metric = criterion.metric;
  if (!metric) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: "metric criterion has no metric definition",
    };
  }

  const runs = currentRuns(options.state.results, options.state.currentExperimentIndex);
  if (runs.length === 0) {
    return {
      criterionId: criterion.id,
      pass: true,
      blocking: criterion.blocking,
      detail: "baseline run — no prior metric to compare",
    };
  }

  const baseline = runs[0].metric;
  const current = options.metric;
  const delta = metric.direction === "lower" ? baseline - current : current - baseline;
  const relativePct = baseline === 0 ? null : (delta / Math.abs(baseline)) * 100;
  const requiredPct = metric.minDeltaPct ?? 0;

  if (delta <= 0) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: `${metric.name} did not improve: baseline ${baseline}, current ${current}`,
    };
  }

  if (relativePct !== null && relativePct < requiredPct) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: `${metric.name} improved ${relativePct.toFixed(2)}%, below the required ${requiredPct}%`,
    };
  }

  if (
    options.state.confidence !== null &&
    options.state.confidence < 1.0 &&
    options.forceKeep !== true
  ) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: `improvement is within noise (confidence ${options.state.confidence.toFixed(2)}x < 1.0x); rerun to confirm or pass force_keep with a reason in ASI`,
    };
  }

  return {
    criterionId: criterion.id,
    pass: true,
    blocking: criterion.blocking,
    detail: `${metric.name} improved ${relativePct === null ? "from zero baseline" : `${relativePct.toFixed(2)}%`} (baseline ${baseline} -> ${current})`,
  };
}

async function evaluateCommandCriterion(
  criterion: Criterion,
  options: GateOptions,
): Promise<CriterionVerdict> {
  const check = criterion.check!;
  const timeout = (check.timeoutSeconds ?? 300) * 1000;
  try {
    const result = await options.pi.exec("bash", ["-c", check.command], {
      cwd: options.workDir,
      timeout,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const pass = expectationsPass(check.expect, check.pattern, result.code, output);
    return {
      criterionId: criterion.id,
      pass,
      blocking: criterion.blocking,
      detail: pass
        ? `${check.command} passed`
        : `${check.command} failed (exit ${result.code ?? "?"}): ${tail(output)}`,
    };
  } catch (error) {
    return {
      criterionId: criterion.id,
      pass: false,
      blocking: criterion.blocking,
      detail: `${check.command} failed to run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function expectationsPass(
  expect: "exit0" | "stdout_contains" | "stdout_regex",
  pattern: string | undefined,
  code: number | null,
  output: string,
): boolean {
  if (expect === "exit0") return code === 0;
  if (!pattern) return false;
  if (expect === "stdout_contains") return output.includes(pattern);
  try {
    return new RegExp(pattern).test(output);
  } catch {
    return false;
  }
}

function evaluateChangedPaths(options: GateOptions): CriterionVerdict[] {
  const verdicts: CriterionVerdict[] = [];
  const changed = options.changedPaths;

  if (!options.contract.allowTestEdits && !options.state.testEditsAllowed && options.contract.testGlobs.length > 0) {
    const touchedTests = changed.filter((filePath) =>
      options.contract.testGlobs.some((glob) => matchGlob(filePath, glob)),
    );
    if (touchedTests.length > 0) {
      verdicts.push({
        criterionId: "L2-tests",
        pass: false,
        blocking: true,
        detail: `test files changed while protected: ${touchedTests.slice(0, 10).join(", ")}`,
      });
    } else {
      verdicts.push({
        criterionId: "L2-tests",
        pass: true,
        blocking: true,
        detail: "no protected test files changed",
      });
    }
  }

  if (options.contract.scopeGlobs.length > 0) {
    const outside = changed.filter(
      (filePath) => !options.contract.scopeGlobs.some((glob) => matchGlob(filePath, glob)),
    );
    verdicts.push({
      criterionId: "L2-scope",
      pass: outside.length === 0,
      blocking: true,
      detail:
        outside.length === 0
          ? "all changed paths are inside the contract scope"
          : `changed paths outside the contract scope: ${outside.slice(0, 10).join(", ")}`,
    });
  }

  return verdicts;
}

function tail(output: string): string {
  return output.split("\n").slice(-5).join("\n").slice(-500);
}

function globToRegExp(glob: string): RegExp {
  let result = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      result += "[^/]";
      continue;
    }
    result += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${result}$`);
}
