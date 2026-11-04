import { inferMetricUnit } from "../domain/metric-definition.ts";
import {
  emptyGoalProtocolState,
  type Attempt,
  type CheckExpectation,
  type Criterion,
  type CriterionCheck,
  type CriterionKind,
  type CriterionMetric,
  type CriterionVerdict,
  type Direction,
  type DirectionEvidence,
  type DirectionStatus,
  type GateResult,
  type GoalContract,
  type GoalProtocolState,
  type ProbeRecord,
  type ReviewFinding,
  type ReviewRepro,
  type ReviewResult,
} from "../domain/goal-contract.ts";

export type JournalEntry = Record<string, unknown>;

export interface ResearchConfigEntry extends JournalEntry {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher";
}

export interface ResearchRunEntry extends JournalEntry {
  run: number;
}

export interface ResearchJournalMetricDef {
  name: string;
  unit: string;
}

export interface ResearchJournalRun {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  experimentIndex: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface ResearchJournalModel extends GoalProtocolState {
  hasConfig: boolean;
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentExperimentIndex: number;
  results: ResearchJournalRun[];
  secondaryMetrics: ResearchJournalMetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION = "lower" as const;

function isObjectRecord(value: unknown): value is JournalEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

function statusFrom(value: unknown): ResearchJournalRun["status"] {
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  return "keep";
}

function directionFrom(value: unknown): ResearchJournalModel["bestDirection"] {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ResearchJournalModel {
  return {
    ...emptyGoalProtocolState(),
    hasConfig: false,
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentExperimentIndex: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ResearchJournalModel, entry: ResearchConfigEntry): void {
  state.hasConfig = true;
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextExperimentIndex(state: ResearchJournalModel, experimentIndex: number): number {
  if (state.results.length === 0) return experimentIndex;
  state.secondaryMetrics = [];
  return experimentIndex + 1;
}

function runFrom(entry: ResearchRunEntry, experimentIndex: number): ResearchJournalRun {
  const entryExperimentIndex = typeof entry.experimentIndex === "number" ? entry.experimentIndex : experimentIndex;
  return {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: typeof entry.metric === "number" ? entry.metric : 0,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    experimentIndex: entryExperimentIndex,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(state: ResearchJournalModel, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

const CRITERION_KINDS: readonly CriterionKind[] = ["metric", "command", "test", "manual"];
const CHECK_EXPECTATIONS: readonly CheckExpectation[] = ["exit0", "stdout_contains", "stdout_regex"];
const DIRECTION_STATUSES: readonly DirectionStatus[] = ["open", "running", "kept", "killed"];
const METRIC_DIRECTIONS = ["lower", "higher"] as const;
const ATTEMPT_STATUSES = ["discard", "crash", "checks_failed"] as const;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isString);
}

function criterionCheckFrom(value: unknown): CriterionCheck | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (!isString(value.command) || !isOneOf(value.expect, CHECK_EXPECTATIONS)) return undefined;
  return {
    command: value.command,
    expect: value.expect,
    pattern: isString(value.pattern) ? value.pattern : undefined,
    timeoutSeconds: isNumber(value.timeoutSeconds) ? value.timeoutSeconds : undefined,
  };
}

function criterionMetricFrom(value: unknown): CriterionMetric | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (!isString(value.name) || !isOneOf(value.direction, METRIC_DIRECTIONS)) return undefined;
  return {
    name: value.name,
    direction: value.direction,
    unit: isString(value.unit) ? value.unit : undefined,
    minDeltaPct: isNumber(value.minDeltaPct) ? value.minDeltaPct : undefined,
  };
}

function criterionFrom(value: unknown): Criterion | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.id) || !isString(value.statement)) return null;
  if (!isOneOf(value.kind, CRITERION_KINDS) || typeof value.blocking !== "boolean") return null;
  return {
    id: value.id,
    statement: value.statement,
    kind: value.kind,
    blocking: value.blocking,
    check: criterionCheckFrom(value.check),
    metric: criterionMetricFrom(value.metric),
    guardOf: isString(value.guardOf) ? value.guardOf : undefined,
  };
}

function contractFrom(value: unknown): GoalContract | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.hash) || !Array.isArray(value.criteria)) return null;
  const criteria: Criterion[] = [];
  for (const candidate of value.criteria) {
    const criterion = criterionFrom(candidate);
    if (!criterion) return null;
    criteria.push(criterion);
  }
  return {
    version: 1,
    objective: isString(value.objective) ? value.objective : "",
    criteria,
    testGlobs: stringArrayFrom(value.testGlobs),
    allowTestEdits: value.allowTestEdits === true,
    frozenAt: isNumber(value.frozenAt) ? value.frozenAt : 0,
    hash: value.hash,
  };
}

function directionEvidenceFrom(value: unknown): DirectionEvidence | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (!isString(value.command) || !isString(value.outputHash)) return undefined;
  return {
    command: value.command,
    value: isNumber(value.value) ? value.value : null,
    outputHash: value.outputHash,
    at: isNumber(value.at) ? value.at : 0,
  };
}

function goalDirectionFrom(value: unknown): Direction | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.id) || !isString(value.title)) return null;
  if (!isOneOf(value.status, DIRECTION_STATUSES)) return null;
  return {
    id: value.id,
    title: value.title,
    mechanism: isString(value.mechanism) ? value.mechanism : "",
    proxyMetric: isString(value.proxyMetric) ? value.proxyMetric : "",
    cost: isString(value.cost) ? value.cost : "",
    risk: isString(value.risk) ? value.risk : "",
    killIf: isString(value.killIf) ? value.killIf : "",
    status: value.status,
    evidence: directionEvidenceFrom(value.evidence),
  };
}

function probeFrom(value: unknown): ProbeRecord | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.directionId) || !isString(value.command)) return null;
  if (!isString(value.evidenceHash) || !isOneOf(value.decision, ["keep", "kill"] as const)) return null;
  return {
    directionId: value.directionId,
    command: value.command,
    value: isNumber(value.value) ? value.value : null,
    evidenceHash: value.evidenceHash,
    decision: value.decision,
    at: isNumber(value.at) ? value.at : 0,
  };
}

function criterionVerdictFrom(value: unknown): CriterionVerdict | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.criterionId) || typeof value.pass !== "boolean" || typeof value.blocking !== "boolean") return null;
  return {
    criterionId: value.criterionId,
    pass: value.pass,
    blocking: value.blocking,
    detail: isString(value.detail) ? value.detail : "",
  };
}

function gateFrom(value: unknown): GateResult | null {
  if (!isObjectRecord(value)) return null;
  if (!isOneOf(value.verdict, ["pass", "fail"] as const) || !isString(value.contractHash)) return null;
  if (!Array.isArray(value.criteria)) return null;
  const criteria: CriterionVerdict[] = [];
  for (const candidate of value.criteria) {
    const verdict = criterionVerdictFrom(candidate);
    if (!verdict) return null;
    criteria.push(verdict);
  }
  return {
    verdict: value.verdict,
    contractHash: value.contractHash,
    checkedAt: isNumber(value.checkedAt) ? value.checkedAt : 0,
    criteria,
  };
}

function reviewReproFrom(value: unknown): ReviewRepro | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (!isOneOf(value.kind, ["command", "test"] as const) || !isString(value.payload)) return undefined;
  return {
    kind: value.kind,
    payload: value.payload,
    expected: isString(value.expected) ? value.expected : undefined,
    actual: isString(value.actual) ? value.actual : undefined,
  };
}

function reviewFindingFrom(value: unknown): ReviewFinding | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.id) || !isString(value.claim)) return null;
  if (!isOneOf(value.severity, ["blocking", "advisory"] as const)) return null;
  return {
    id: value.id,
    criterionId: isString(value.criterionId) ? value.criterionId : undefined,
    severity: value.severity,
    file: isString(value.file) ? value.file : undefined,
    line: isNumber(value.line) ? value.line : undefined,
    claim: value.claim,
    repro: reviewReproFrom(value.repro),
    reproduced: value.reproduced === true,
    detail: isString(value.detail) ? value.detail : undefined,
  };
}

function reviewFrom(value: unknown): ReviewResult | null {
  if (!isObjectRecord(value)) return null;
  if (!isString(value.reviewer) || !Array.isArray(value.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const candidate of value.findings) {
    const finding = reviewFindingFrom(candidate);
    if (!finding) return null;
    findings.push(finding);
  }
  return {
    reviewer: value.reviewer,
    at: isNumber(value.at) ? value.at : 0,
    findings,
  };
}

function attemptFrom(value: unknown): Attempt | null {
  if (!isObjectRecord(value)) return null;
  if (!isNumber(value.run) || !isOneOf(value.status, ATTEMPT_STATUSES)) return null;
  if (!isString(value.checkpoint) || !isString(value.patchPath)) return null;
  return {
    run: value.run,
    status: value.status,
    checkpoint: value.checkpoint,
    patchPath: value.patchPath,
    description: isString(value.description) ? value.description : "",
    at: isNumber(value.at) ? value.at : 0,
  };
}

function upsertDirection(state: ResearchJournalModel, direction: Direction): void {
  const index = state.directions.findIndex((candidate) => candidate.id === direction.id);
  if (index === -1) {
    state.directions.push(direction);
  } else {
    state.directions[index] = direction;
  }
}

export function parseJournalEntry(line: string): JournalEntry | null {
  try {
    const parsed = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isResearchConfigEntry(entry: unknown): entry is ResearchConfigEntry {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isRunResultEntry(entry: unknown): entry is ResearchRunEntry {
  return isObjectRecord(entry) && typeof entry.run === "number";
}

function firstConfigEntry(jsonlContent: string): ResearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJournalEntry(line);
    if (isResearchConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasResearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractResearchName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Research";
}

export function parseResearchJournalModel(jsonlContent: string): ResearchJournalModel {
  const state = reconstructedState();
  let experimentIndex = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJournalEntry(line);
    if (!entry) continue;

    if (isResearchConfigEntry(entry)) {
      updateConfig(state, entry);
      experimentIndex = nextExperimentIndex(state, experimentIndex);
      state.currentExperimentIndex = experimentIndex;
      continue;
    }

    if (entry.type === "contract") {
      const contract = contractFrom(entry.contract);
      if (contract) state.contract = contract;
      continue;
    }

    if (entry.type === "direction") {
      const direction = goalDirectionFrom(entry.direction);
      if (direction) upsertDirection(state, direction);
      continue;
    }

    if (entry.type === "probe") {
      const probe = probeFrom(entry.probe);
      if (probe) state.probes.push(probe);
      continue;
    }

    if (entry.type === "gate") {
      const gate = gateFrom(entry.gate);
      if (gate) state.gates.push(gate);
      continue;
    }

    if (entry.type === "review") {
      const review = reviewFrom(entry.review);
      if (review) state.reviews.push(review);
      continue;
    }

    if (entry.type === "attempt") {
      const attempt = attemptFrom(entry.attempt);
      if (attempt) state.attempts.push(attempt);
      continue;
    }

    if (!isRunResultEntry(entry)) continue;

    const run = runFrom(entry, experimentIndex);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
