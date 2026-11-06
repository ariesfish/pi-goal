/**
 * Every number the dashboard, the widget, the run renderers, and the
 * compaction summary print goes through this module, so a metric looks the
 * same wherever it appears.
 */

/** Human-facing metric text: grouped thousands, 0 or 2 decimals, with unit. */
export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const decimals = value === Math.round(value) ? 0 : 2;
  return formatNumberWithCommas(value, decimals) + (unit || "");
}

/** Prompt-facing metric text: no grouping, e.g. "15200" or "12.50". */
export function formatPlainMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Signed percent change, e.g. "+1.2%" or "-20.0%". */
export function formatDeltaPercent(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** The parenthesised suffix printed next to a metric value; empty when unknown. */
export function formatDeltaSuffix(pct: number | null): string {
  return pct === null ? "" : ` (${formatDeltaPercent(pct)})`;
}

function formatNumberWithCommas(value: number, decimals: number): string {
  const fixed = decimals > 0
    ? Math.abs(value).toFixed(decimals)
    : String(Math.round(Math.abs(value)));
  const [intPart, fracPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${grouped}${fracPart ? `.${fracPart}` : ""}`;
}
