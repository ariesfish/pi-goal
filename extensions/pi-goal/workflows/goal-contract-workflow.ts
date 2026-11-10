import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import {
  allDirectionsClosed,
  computeContractHash,
  contractReadyToSeal,
  directionsReadyForProbing,
  directionCardComplete,
  primaryMetricCriterion,
  type CheckExpectation,
  type Criterion,
  type CriterionCheck,
  type CriterionKind,
  type CriterionMetric,
  type Direction,
  type GoalContract,
  type MetricDirection,
  type ProbeRecord,
} from "../domain/goal-contract.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { runShellCommand } from "../execution/shell-command-runner.ts";
import type { HostExec } from "../support/exec.ts";
import {
  appendJournalEntry,
  contractJournalEntry,
  directionJournalEntry,
  experimentConfigJournalEntry,
  probeJournalEntry,
} from "../persistence/research-journal.ts";
import {
  enterResearchConverging,
  enterResearchProbing,
  sealResearchContract,
} from "../protocol/research-phase.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import {
  checkResearchWorkspace,
  formatWorkspaceSafetyError,
} from "../workspace/research-workspace.ts";

export interface DirectionCardInput {
  id: string;
  title: string;
  mechanism: string;
  proxyMetric: string;
  cost: string;
  risk: string;
  killIf: string;
}

export interface FrameGoalParams {
  directions: DirectionCardInput[];
}

export interface ProbeGoalParams {
  direction_id: string;
  command: string;
  timeout_seconds?: number;
  value?: number;
  decision: "keep" | "kill";
  note?: string;
}

export interface FreezeCriterionInput {
  id: string;
  statement: string;
  kind: CriterionKind;
  blocking: boolean;
  check?: {
    command: string;
    expect: CheckExpectation;
    pattern?: string;
    timeout_seconds?: number;
  };
  metric?: {
    name: string;
    direction: MetricDirection;
    unit?: string;
    min_delta_pct?: number;
  };
  guard_of?: string;
}

export interface FreezeCriteriaParams {
  name?: string;
  objective: string;
  criteria: FreezeCriterionInput[];
  test_globs?: string[];
  scope_globs?: string[];
  allow_test_edits?: boolean;
}

export interface GoalWorkflowDeps {
  runtime: SessionRuntime;
  workDir: string;
  confirm(message: string): Promise<boolean>;
  exec?: HostExec;
}

export type GoalContractWorkflowResult =
  | { ok: true; text: string; state: ResearchState }
  | { ok: false; text: string };

export function executeFrameGoal(
  params: FrameGoalParams,
  deps: GoalWorkflowDeps,
): GoalContractWorkflowResult {
  const { runtime, workDir } = deps;
  if (runtime.loop.phase !== "framing" && runtime.loop.phase !== "needs_init") {
    return blocked(`frame_goal runs while framing. Current phase: ${runtime.loop.phase}.`);
  }
  if (!Array.isArray(params.directions) || params.directions.length === 0) {
    return blocked("frame_goal needs at least one direction card.");
  }

  const directions: Direction[] = runtime.state.directions.map((direction) => ({ ...direction }));
  for (const input of params.directions) {
    const card: Direction = {
      id: input.id.trim(),
      title: input.title.trim(),
      mechanism: input.mechanism.trim(),
      proxyMetric: input.proxyMetric.trim(),
      cost: input.cost.trim(),
      risk: input.risk.trim(),
      killIf: input.killIf.trim(),
      status: existingStatus(directions, input.id),
      evidence: existingEvidence(directions, input.id),
    };
    if (!directionCardComplete(card)) {
      return blocked(
        `Direction ${card.id || "(missing id)"} is incomplete: id, title, mechanism, proxy metric, cost, risk, and kill condition are required.`,
      );
    }
    upsert(directions, card);
  }

  const ready = directionsReadyForProbing(directions);
  if (!ready.ok) return blocked(ready.reason ?? "Directions are not ready.");

  for (const input of params.directions) {
    const card = directions.find((direction) => direction.id === input.id.trim());
    if (!card) continue;
    const journalError = appendJournalEntry(workDir, directionJournalEntry(card));
    if (journalError) return blocked(journalError);
  }

  runtime.state.directions = directions;
  const transition = enterResearchProbing(runtime.loop, directions);
  if (!transition.ok) return blocked(transition.reason ?? "Could not enter probing.");

  return {
    ok: true,
    text: [
      `✅ ${directions.length} direction${directions.length === 1 ? "" : "s"} registered. Phase: probing.`,
      ...directions.map((direction) => `- ${direction.id}: ${direction.title} (proxy: ${direction.proxyMetric})`),
      "Next: call probe_goal for every open direction. Each probe must end kept or killed with an evidence pointer.",
    ].join("\n"),
    state: runtime.state,
  };
}

export async function executeProbeGoal(
  params: ProbeGoalParams,
  deps: GoalWorkflowDeps,
): Promise<GoalContractWorkflowResult> {
  const { runtime, workDir } = deps;
  if (runtime.loop.phase !== "probing") {
    return blocked(`probe_goal runs while probing. Current phase: ${runtime.loop.phase}.`);
  }
  const direction = runtime.state.directions.find(
    (candidate) => candidate.id === params.direction_id,
  );
  if (!direction) {
    return blocked(`Unknown direction: ${params.direction_id}. Known: ${runtime.state.directions.map((candidate) => candidate.id).join(", ") || "(none)"}.`);
  }
  if (direction.status === "kept" || direction.status === "killed") {
    return blocked(`Direction ${direction.id} is already closed as ${direction.status}.`);
  }
  if (!params.command?.trim()) return blocked("probe_goal needs a command.");

  const startedAt = Date.now();
  const run = await runShellCommand({
    command: params.command,
    workDir,
    timeoutMs: (params.timeout_seconds ?? 120) * 1000,
    getTempFile: () => path.join(os.tmpdir(), `pi-goal-probe-${randomBytes(4).toString("hex")}.log`),
    startedAt,
  });

  const parsed = run.metrics;
  const value = resolveProbeValue(params.value, parsed, direction.proxyMetric);
  if (value === null) {
    const available = [...parsed.keys()];
    return blocked(
      `Probe produced no value for proxy metric "${direction.proxyMetric}". ` +
        (available.length > 0
          ? `Parsed METRIC lines: ${available.join(", ")}. Pass \`value\` explicitly or fix the METRIC line.`
          : "No METRIC lines were parsed. Emit `METRIC name=value` from the probe command or pass `value` explicitly."),
    );
  }

  const crashed = run.timedOut || run.exitCode !== 0;
  const decision: "keep" | "kill" = crashed || params.decision === "kill" ? "kill" : "keep";
  const at = Date.now();
  const updated: Direction = {
    ...direction,
    status: decision === "keep" ? "kept" : "killed",
    evidence: {
      command: params.command,
      value,
      outputHash: run.outputHash,
      at,
    },
  };
  const probe: ProbeRecord = {
    directionId: direction.id,
    command: params.command,
    value,
    evidenceHash: updated.evidence!.outputHash,
    decision,
    at,
  };

  const directionError = appendJournalEntry(workDir, directionJournalEntry(updated));
  if (directionError) return blocked(directionError);
  const probeError = appendJournalEntry(workDir, probeJournalEntry(probe));
  if (probeError) return blocked(probeError);

  upsert(runtime.state.directions, updated);
  runtime.state.probes.push(probe);

  let next = "Next: probe the remaining open directions.";
  if (allDirectionsClosed(runtime.state.directions).ok) {
    const transition = enterResearchConverging(runtime.loop, runtime.state.directions);
    if (transition.ok) {
      next = "All directions closed. Phase: converging. Next: call freeze_criteria with a primary metric and an executable check for every blocking criterion.";
    }
  }

  const crashNote = crashed
    ? `\n⚠️ Probe command ${run.timedOut ? "timed out" : `exited ${run.exitCode}`}; recorded as killed.`
    : "";
  return {
    ok: true,
    text: [
      `${decision === "keep" ? "✅" : "⛔"} ${direction.id}: ${decision} (${direction.proxyMetric} = ${value}).`,
      `evidence: ${probe.evidenceHash}`,
      params.note ? `note: ${params.note}` : "",
      crashNote,
      next,
    ].filter(Boolean).join("\n"),
    state: runtime.state,
  };
}

export async function executeFreezeCriteria(
  params: FreezeCriteriaParams,
  deps: GoalWorkflowDeps,
): Promise<GoalContractWorkflowResult> {
  const { runtime, workDir } = deps;
  const phase = runtime.loop.phase;
  if (phase !== "converging" && phase !== "framing" && phase !== "needs_init") {
    return blocked(`freeze_criteria runs after converging. Current phase: ${phase}.`);
  }
  if (deps.exec) {
    const workspace = await checkResearchWorkspace(deps.exec, workDir);
    const dirty = formatWorkspaceSafetyError(workspace);
    if (dirty) return blocked(dirty);
  }
  if (!params.objective?.trim()) return blocked("freeze_criteria needs an objective.");
  if (!Array.isArray(params.criteria) || params.criteria.length === 0) {
    return blocked("freeze_criteria needs at least one criterion.");
  }

  const criteria = params.criteria.map(criterionFrom);
  const base = {
    version: 1 as const,
    objective: params.objective.trim(),
    criteria,
    testGlobs: params.test_globs ?? [],
    scopeGlobs: params.scope_globs ?? [],
    allowTestEdits: params.allow_test_edits === true,
    frozenAt: Date.now(),
  };
  const contract: GoalContract = { ...base, hash: computeContractHash(base) };

  const ready = contractReadyToSeal(contract);
  if (!ready.ok) return blocked(ready.reason ?? "The contract is not ready.");
  const primary = primaryMetricCriterion(contract);
  if (!primary.ok || !primary.criterion?.metric) {
    return blocked(primary.reason ?? "The contract needs one primary metric.");
  }

  const confirmed = await deps.confirm(confirmationMessage(contract, primary.criterion));
  if (!confirmed) {
    return blocked("Contract not frozen: the human declined confirmation.");
  }

  const contractError = appendJournalEntry(workDir, contractJournalEntry(contract));
  if (contractError) return blocked(contractError);

  const metric = primary.criterion.metric;
  const configState = {
    ...runtime.state,
    name: params.name ?? runtime.state.name ?? "Research",
    metricName: metric.name,
    metricUnit: metric.unit ?? "",
    bestDirection: metric.direction,
  } as ResearchState;
  const configError = appendJournalEntry(workDir, experimentConfigJournalEntry(configState));
  if (configError) return blocked(configError);

  runtime.state.contract = contract;
  runtime.state.name = configState.name;
  runtime.state.metricName = metric.name;
  runtime.state.metricUnit = metric.unit ?? "";
  runtime.state.bestDirection = metric.direction;

  const hasBaseline = runtime.state.results.length > 0;
  const sealed = sealResearchContract(runtime.loop, contract, { hasBaseline });
  if (!sealed.ok) return blocked(sealed.reason ?? "Could not seal the contract.");

  return {
    ok: true,
    text: [
      `🔒 Contract frozen: ${contract.hash}`,
      `Primary metric: ${metric.name} (${metric.direction} is better).`,
      `${contract.criteria.filter((criterion) => criterion.blocking).length} blocking criteria, ${contract.criteria.length} total.`,
      contract.testGlobs.length > 0
        ? `Test files protected: ${contract.testGlobs.join(", ")}${contract.allowTestEdits ? " (edits currently allowed)" : ""}.`
        : "No test globs protected.",
      hasBaseline
        ? "Baseline already exists. Phase: sealed. Next: run_goal."
        : "Next: run the baseline with run_goal, then log_goal.",
    ].join("\n"),
    state: runtime.state,
  };
}

function criterionFrom(input: FreezeCriterionInput): Criterion {
  const check: CriterionCheck | undefined = input.check
    ? {
        command: input.check.command,
        expect: input.check.expect,
        pattern: input.check.pattern,
        timeoutSeconds: input.check.timeout_seconds,
      }
    : undefined;
  const metric: CriterionMetric | undefined = input.metric
    ? {
        name: input.metric.name,
        direction: input.metric.direction,
        unit: input.metric.unit,
        minDeltaPct: input.metric.min_delta_pct,
      }
    : undefined;
  return {
    id: input.id,
    statement: input.statement,
    kind: input.kind,
    blocking: input.blocking,
    check,
    metric,
    guardOf: input.guard_of,
  };
}

function confirmationMessage(contract: GoalContract, primaryMetric: Criterion): string {
  return [
    `Freeze this goal contract? ${contract.hash}`,
    "",
    `Objective: ${contract.objective}`,
    `Primary metric: ${primaryMetric.metric?.name} (${primaryMetric.metric?.direction} is better)`,
    "",
    ...contract.criteria.map(
      (criterion) =>
        `- ${criterion.id} [${criterion.kind}${criterion.blocking ? ", blocking" : ""}] ${criterion.statement}`,
    ),
    "",
    contract.testGlobs.length > 0
      ? `Test files protected: ${contract.testGlobs.join(", ")}`
      : "No test files protected.",
    "After sealing, changing the contract requires a human decision.",
  ].join("\n");
}

function resolveProbeValue(
  explicit: number | undefined,
  parsed: Map<string, number>,
  proxyMetric: string,
): number | null {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const matched = parsed.get(proxyMetric);
  if (matched !== undefined) return matched;
  if (parsed.size === 1) return [...parsed.values()][0];
  return null;
}

function existingStatus(directions: Direction[], id: string): Direction["status"] {
  return directions.find((direction) => direction.id === id.trim())?.status ?? "open";
}

function existingEvidence(directions: Direction[], id: string): Direction["evidence"] {
  return directions.find((direction) => direction.id === id.trim())?.evidence;
}

function upsert(directions: Direction[], next: Direction): void {
  const index = directions.findIndex((direction) => direction.id === next.id);
  if (index === -1) directions.push(next);
  else directions[index] = next;
}

function blocked(text: string): GoalContractWorkflowResult {
  return { ok: false, text: `❌ ${text}` };
}
