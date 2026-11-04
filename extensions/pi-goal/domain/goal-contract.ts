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
