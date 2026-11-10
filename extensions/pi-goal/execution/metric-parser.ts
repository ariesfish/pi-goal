import { StringDecoder } from "node:string_decoder";

const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_PREFIX_LENGTH = "METRIC ".length;
export const MAX_METRIC_LINE_BYTES = 4 * 1024;

export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

/** Collect complete metric lines even after their log bytes leave the display tail. */
export function createMetricCollector(metrics = new Map<string, number>()) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let skippingLine = false;

  function collect(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      if (!skippingLine) {
        pending += text.slice(start, end);
        // Ordinary log lines can be arbitrarily long; do not buffer them.
        if (
          Buffer.byteLength(pending, "utf8") > MAX_METRIC_LINE_BYTES ||
          (pending.length >= METRIC_PREFIX_LENGTH && !/^METRIC\s/.test(pending))
        ) {
          pending = "";
          skippingLine = true;
        }
      }
      if (newline === -1) break;
      if (!skippingLine) {
        for (const [name, value] of parseMetricLines(pending)) metrics.set(name, value);
      }
      pending = "";
      skippingLine = false;
      start = newline + 1;
    }
  }

  return {
    write(data: Buffer): void {
      collect(decoder.write(data));
    },
    finish(): Map<string, number> {
      collect(decoder.end());
      if (!skippingLine) {
        for (const [name, value] of parseMetricLines(pending)) metrics.set(name, value);
      }
      pending = "";
      return metrics;
    },
  };
}
