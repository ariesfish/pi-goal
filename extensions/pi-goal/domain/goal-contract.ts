import { createHash } from "node:crypto";

export type CriterionKind = "metric" | "command" | "test" | "manual";
export type CheckExpectation = "exit0" | "stdout_contains" | "stdout_regex";
export type DirectionStatus = "open" | "running" | "kept" | "killed";
export type MetricDirection = "lower" | "higher";

export interface CriterionCheck {
  command: string;
  expect: CheckExpectation;
  pattern?: string;
  timeoutSeconds?: number;
}

export interface CriterionMetric {
  name: string;
  direction: MetricDirection;
  unit?: string;
  minDeltaPct?: number;
}

export interface Criterion {
  id: string;
  statement: string;
  kind: CriterionKind;
  blocking: boolean;
  check?: CriterionCheck;
  metric?: CriterionMetric;
  guardOf?: string;
}

export interface GoalContract {
  version: 1;
  objective: string;
  criteria: Criterion[];
  testGlobs: string[];
  scopeGlobs: string[];
  allowTestEdits: boolean;
  frozenAt: number;
  hash: string;
}

export interface DirectionEvidence {
  command: string;
  value: number | null;
  outputHash: string;
  at: number;
}

export interface Direction {
  id: string;
  title: string;
  mechanism: string;
  proxyMetric: string;
  cost: string;
  risk: string;
  killIf: string;
  status: DirectionStatus;
  evidence?: DirectionEvidence;
}

export interface ProbeRecord {
  directionId: string;
  command: string;
  value: number | null;
  evidenceHash: string;
  decision: "keep" | "kill";
  at: number;
}

export interface CriterionVerdict {
  criterionId: string;
  pass: boolean;
  blocking: boolean;
  detail: string;
}

export interface GateResult {
  verdict: "pass" | "fail";
  contractHash: string;
  checkedAt: number;
  criteria: CriterionVerdict[];
}

export interface ReviewRepro {
  kind: "command" | "test";
  payload: string;
  expected?: string;
  actual?: string;
}

export interface ReviewFinding {
  id: string;
  criterionId?: string;
  severity: "blocking" | "advisory";
  file?: string;
  line?: number;
  claim: string;
  repro?: ReviewRepro;
  reproduced: boolean;
  detail?: string;
}

export interface ReviewResult {
  reviewer: string;
  at: number;
  findings: ReviewFinding[];
}

export interface Attempt {
  run: number;
  status: "discard" | "crash" | "checks_failed";
  checkpoint: string;
  patchPath: string;
  description: string;
  at: number;
}

export interface GoalProtocolState {
  contract: GoalContract | null;
  directions: Direction[];
  probes: ProbeRecord[];
  gates: GateResult[];
  reviews: ReviewResult[];
  attempts: Attempt[];
}

export function emptyGoalProtocolState(): GoalProtocolState {
  return {
    contract: null,
    directions: [],
    probes: [],
    gates: [],
    reviews: [],
    attempts: [],
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const stable: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      stable[key] = stableValue(entry);
    }
    return stable;
  }
  return value;
}

export function computeContractHash(
  contract: Omit<GoalContract, "hash"> | GoalContract,
): string {
  const { hash: _ignored, ...rest } = contract as GoalContract;
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(rest))).digest("hex")}`;
}

export function legacyMetricContract(input: {
  metricName: string;
  direction: MetricDirection;
  objective?: string;
}): GoalContract {
  const base: Omit<GoalContract, "hash"> = {
    version: 1,
    objective: input.objective ?? `Legacy metric loop on ${input.metricName}`,
    criteria: [
      {
        id: "M1",
        statement: `${input.metricName} improves (${input.direction} is better)`,
        kind: "metric",
        blocking: true,
        metric: { name: input.metricName, direction: input.direction },
      },
    ],
    testGlobs: [],
    scopeGlobs: [],
    allowTestEdits: false,
    frozenAt: 0,
  };
  return { ...base, hash: computeContractHash(base) };
}

export function criterionHasExecutableCheck(criterion: Criterion): boolean {
  if (criterion.kind === "manual") return false;
  if (criterion.check) return true;
  return criterion.kind === "metric" && Boolean(criterion.metric);
}

export function blockingCriteriaHaveChecks(contract: GoalContract): boolean {
  const blocking = contract.criteria.filter((criterion) => criterion.blocking);
  if (blocking.length === 0) return false;
  return blocking.every((criterion) => criterionHasExecutableCheck(criterion));
}

export function directionCardComplete(direction: Direction): boolean {
  return [
    direction.id,
    direction.title,
    direction.mechanism,
    direction.proxyMetric,
    direction.cost,
    direction.risk,
    direction.killIf,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

export function directionIsClosed(direction: Direction): boolean {
  if (direction.status !== "kept" && direction.status !== "killed") return false;
  const evidence = direction.evidence;
  return Boolean(
    evidence &&
    evidence.command.trim().length > 0 &&
    evidence.outputHash.trim().length > 0,
  );
}

export function directionsReadyForProbing(directions: Direction[]): { ok: boolean; reason?: string } {
  if (directions.length < 2) {
    return { ok: false, reason: "At least two orthogonal directions are required before probing." };
  }
  for (const direction of directions) {
    if (!directionCardComplete(direction)) {
      return {
        ok: false,
        reason: `Direction ${direction.id || "(missing id)"} is incomplete: mechanism, proxy metric, cost, risk, and kill condition are required.`,
      };
    }
  }
  return { ok: true };
}

export function allDirectionsClosed(directions: Direction[]): { ok: boolean; reason?: string } {
  if (directions.length < 2) {
    return { ok: false, reason: "At least two directions are required before converging." };
  }
  const open = directions.filter((direction) => !directionIsClosed(direction));
  if (open.length > 0) {
    return {
      ok: false,
      reason: `Directions without a keep/kill decision and evidence: ${open.map((direction) => direction.id).join(", ")}.`,
    };
  }
  return { ok: true };
}

export function primaryMetricCriterion(contract: GoalContract): { ok: boolean; criterion?: Criterion; reason?: string } {
  const metrics = contract.criteria.filter(
    (criterion) => criterion.kind === "metric" && criterion.blocking,
  );
  if (metrics.length === 0) {
    return { ok: false, reason: "The contract needs one blocking metric criterion as the primary target." };
  }
  if (metrics.length > 1) {
    return {
      ok: false,
      reason: `Exactly one blocking metric criterion may define the primary target; found ${metrics.map((criterion) => criterion.id).join(", ")}.`,
    };
  }
  return { ok: true, criterion: metrics[0] };
}

export function contractReadyToSeal(contract: GoalContract | null): { ok: boolean; reason?: string } {
  if (!contract) return { ok: false, reason: "No goal contract to seal." };
  if (!contract.hash) return { ok: false, reason: "The contract has no hash." };
  if (contract.criteria.length === 0) {
    return { ok: false, reason: "The contract needs at least one blocking criterion." };
  }
  const manualBlocking = contract.criteria.filter(
    (criterion) => criterion.blocking && criterion.kind === "manual",
  );
  if (manualBlocking.length > 0) {
    return {
      ok: false,
      reason: `Manual criteria cannot block: ${manualBlocking.map((criterion) => criterion.id).join(", ")}. Only the human can decide those.`,
    };
  }
  const unchecked = contract.criteria.filter(
    (criterion) => criterion.blocking && !criterionHasExecutableCheck(criterion),
  );
  if (unchecked.length > 0) {
    return {
      ok: false,
      reason: `Blocking criteria need an executable check or metric: ${unchecked.map((criterion) => criterion.id).join(", ")}.`,
    };
  }
  if (!blockingCriteriaHaveChecks(contract)) {
    return { ok: false, reason: "The contract needs at least one blocking criterion with an executable check." };
  }
  return { ok: true };
}

export function isLegacyMetricContract(contract: GoalContract): boolean {
  return (
    contract.criteria.length === 1 &&
    contract.criteria[0].id === "M1" &&
    contract.criteria[0].kind === "metric"
  );
}

export function blockingCriteriaProgress(
  contract: GoalContract | null,
  gate: GateResult | null,
): { passed: number; total: number } {
  if (!contract) return { passed: 0, total: 0 };
  const blocking = new Set(
    contract.criteria.filter((criterion) => criterion.blocking).map((criterion) => criterion.id),
  );
  const passed = gate
    ? gate.criteria.filter((verdict) => verdict.blocking && verdict.pass && blocking.has(verdict.criterionId)).length
    : 0;
  return { passed, total: blocking.size };
}
