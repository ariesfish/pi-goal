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

export interface ReconstructedMetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedRun {
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

export interface ReconstructedResearchState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentExperimentIndex: number;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
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

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

function statusFrom(value: unknown): ReconstructedRun["status"] {
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  return "keep";
}

function directionFrom(value: unknown): ReconstructedResearchState["bestDirection"] {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ReconstructedResearchState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentExperimentIndex: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ReconstructedResearchState, entry: ResearchConfigEntry): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextExperimentIndex(state: ReconstructedResearchState, experimentIndex: number): number {
  if (state.results.length === 0) return experimentIndex;
  state.secondaryMetrics = [];
  return experimentIndex + 1;
}

function runFrom(entry: ResearchRunEntry, experimentIndex: number): ReconstructedRun {
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

function registerSecondaryMetrics(state: ReconstructedResearchState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
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

export function reconstructResearchStateFromJournal(jsonlContent: string): ReconstructedResearchState {
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

    if (!isRunResultEntry(entry)) continue;

    const run = runFrom(entry, experimentIndex);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
