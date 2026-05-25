export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null) return "—";
  const decimals = value === Math.round(value) ? 0 : 2;
  return formatNumberWithCommas(value, decimals) + (unit || "");
}

function formatNumberWithCommas(value: number, decimals: number): string {
  const fixed = decimals > 0
    ? Math.abs(value).toFixed(decimals)
    : String(Math.round(Math.abs(value)));
  const [intPart, fracPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${grouped}${fracPart ? `.${fracPart}` : ""}`;
}
