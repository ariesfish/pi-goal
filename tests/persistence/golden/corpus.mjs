/**
 * The journal decoding contract, as data.
 *
 * Each fixture is a journal that the decoder has to handle the same way
 * forever: malformed lines are skipped, wrong-typed optional fields fall back
 * to their defaults, and an entry whose required core is wrong is dropped
 * whole. `expected.json` is the snapshot taken from the implementation that
 * this corpus was written against; it changes only with a deliberate decision.
 */

const CONFIG = {
  type: "config",
  name: "Speed",
  metricName: "total_ms",
  metricUnit: "ms",
  bestDirection: "lower",
};

const RUN = {
  run: 1,
  commit: "aaa1111",
  metric: 100,
  metrics: { compile_ms: 40 },
  status: "keep",
  description: "baseline",
  timestamp: 1,
  experimentIndex: 0,
  confidence: null,
};

const CONTRACT = {
  version: 1,
  objective: "cut test time",
  criteria: [
    {
      id: "C1",
      statement: "suite faster",
      kind: "metric",
      blocking: true,
      metric: { name: "total_ms", direction: "lower" },
    },
    {
      id: "C2",
      statement: "checks pass",
      kind: "command",
      blocking: true,
      check: { command: "npm test", expect: "exit0" },
    },
  ],
  testGlobs: ["**/*.test.js", 42],
  scopeGlobs: ["src/**"],
  allowTestEdits: false,
  frozenAt: 5,
  hash: "sha256:contract",
};

const DIRECTION = {
  id: "D1",
  title: "memoize",
  mechanism: "cache",
  proxyMetric: "hits",
  cost: "1h",
  risk: "stale",
  killIf: "hit rate < 10%",
  status: "open",
};

const PROBE = {
  directionId: "D1",
  command: "bash probe.sh",
  value: 42,
  evidenceHash: "sha256:probe",
  decision: "keep",
  at: 3,
};

const GATE = {
  verdict: "pass",
  contractHash: "sha256:contract",
  checkedAt: 4,
  criteria: [
    { criterionId: "C1", pass: true, blocking: true, detail: "improved" },
    { criterionId: "L2-scope", pass: true, blocking: true, detail: "inside scope" },
  ],
};

const REVIEW = {
  reviewer: "pi:test",
  at: 6,
  findings: [
    {
      id: "F1",
      severity: "advisory",
      claim: "edge case",
      reproduced: false,
    },
  ],
};

const ATTEMPT = {
  run: 2,
  status: "discard",
  checkpoint: "abc1234",
  patchPath: "attempts/2.patch",
  description: "slower",
  at: 7,
};

const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

export const corpus = [
  { name: "empty journal", journal: "" },
  { name: "whitespace only", journal: "\n\n   \n" },
  {
    name: "malformed json line is skipped",
    journal: '{"type":"config"\n{"type":"config","metricName":"total_ms"}\n',
  },
  {
    name: "non-object json lines are skipped",
    journal: "[1,2]\n\"text\"\n42\nnull\n",
  },
  {
    name: "unknown entry type is ignored",
    journal: lines(CONFIG, { type: "mystery", payload: { a: 1 } }, RUN),
  },
  {
    name: "hook entries are ignored",
    journal: lines(
      CONFIG,
      { type: "hook", stage: "before", exit_code: 0 },
      RUN,
      { type: "hook", stage: "after", exit_code: 0 },
    ),
  },
  { name: "config only", journal: lines(CONFIG) },
  {
    name: "config with missing fields",
    journal: lines({ type: "config" }),
  },
  {
    name: "second config entry resets experiment and secondary metrics",
    journal: lines(CONFIG, RUN, CONFIG, { ...RUN, run: 2, experimentIndex: 1, metrics: { render_ms: 2 } }),
  },
  {
    name: "run status outside the enum normalizes to keep",
    journal: lines(CONFIG, { ...RUN, status: "weird" }),
  },
  {
    name: "bestDirection outside the enum normalizes to lower",
    journal: lines({ ...CONFIG, bestDirection: "up" }),
  },
  {
    name: "run without a run number is not a run",
    journal: lines(CONFIG, { ...RUN, run: undefined }),
  },
  {
    name: "run with wrong-typed fields falls back per field",
    journal: lines(CONFIG, {
      run: 1,
      commit: 7,
      metric: "100",
      metrics: { compile_ms: "40", render_ms: 2 },
      status: 3,
      description: null,
      timestamp: "1",
      experimentIndex: "0",
      confidence: "high",
      asi: "text",
    }),
  },
  {
    name: "run experimentIndex falls back to the running index",
    journal: lines({ ...CONFIG, bestDirection: "lower" }, { ...RUN, experimentIndex: undefined }),
  },
  {
    name: "run keeps asian metric names",
    journal: lines(CONFIG, { ...RUN, metrics: { "総合_µs": 12.5 } }),
  },
  {
    name: "contract entry is kept whole",
    journal: lines(CONFIG, { type: "contract", contract: CONTRACT }, RUN),
  },
  {
    name: "contract without a hash is dropped",
    journal: lines(CONFIG, { type: "contract", contract: { ...CONTRACT, hash: undefined } }),
  },
  {
    name: "contract with criteria that are not an array is dropped",
    journal: lines(CONFIG, { type: "contract", contract: { ...CONTRACT, criteria: "nope" } }),
  },
  {
    name: "one bad criterion drops the whole contract",
    journal: lines(CONFIG, {
      type: "contract",
      contract: { ...CONTRACT, criteria: [CONTRACT.criteria[0], { id: "C2" }] },
    }),
  },
  {
    name: "unknown fields inside a contract are ignored",
    journal: lines(CONFIG, {
      type: "contract",
      contract: { ...CONTRACT, extra: true, criteria: [{ ...CONTRACT.criteria[0], extra: 1 }] },
    }),
  },
  {
    name: "criterion with a broken check keeps the criterion and drops the check",
    journal: lines(CONFIG, {
      type: "contract",
      contract: { ...CONTRACT, criteria: [{ ...CONTRACT.criteria[1], check: { command: 5 } }] },
    }),
  },
  {
    name: "direction entries upsert by id",
    journal: lines(CONFIG, { type: "direction", direction: DIRECTION }, {
      type: "direction",
      direction: { ...DIRECTION, status: "killed", evidence: { command: "probe", value: 11, outputHash: "sha256:abc", at: 2 } },
    }),
  },
  {
    name: "direction without a status is dropped",
    journal: lines(CONFIG, { type: "direction", direction: { ...DIRECTION, status: "paused" } }),
  },
  {
    name: "probe entries are appended",
    journal: lines(CONFIG, { type: "probe", probe: PROBE }, { type: "probe", probe: { ...PROBE, evidenceHash: 5 } }),
  },
  {
    name: "gate entries are appended",
    journal: lines(CONFIG, { type: "gate", gate: GATE }, {
      type: "gate",
      gate: { ...GATE, criteria: [{ criterionId: "C1" }] },
    }),
  },
  {
    name: "review entries are appended",
    journal: lines(CONFIG, { type: "review", review: REVIEW }, {
      type: "review",
      review: { ...REVIEW, findings: [{ id: "F1" }] },
    }),
  },
  {
    name: "attempt entries are appended",
    journal: lines(CONFIG, { type: "attempt", attempt: ATTEMPT }, {
      type: "attempt",
      attempt: { ...ATTEMPT, checkpoint: 5 },
    }),
  },
  {
    name: "policy entries replay in order",
    journal: lines(
      CONFIG,
      RUN,
      { type: "policy", policy: { allowTestEdits: true, allowBenchmarkEdits: true, at: 5 } },
      { type: "policy", policy: { allowTestEdits: false, at: 6 } },
    ),
  },
  {
    name: "policy flags only accept a literal true",
    journal: lines(CONFIG, { type: "policy", policy: { allowTestEdits: "yes", allowBenchmarkEdits: 1 } }),
  },
  {
    name: "legacy journal derives the metric contract from the config header",
    journal: lines(CONFIG, RUN),
  },
  {
    name: "truncated json at the end is skipped",
    journal: lines(CONFIG, RUN) + '{"run":2,"metric":9',
  },
];

export default corpus;
