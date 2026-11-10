import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";

import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { createMetricCollector } from "./metric-parser.ts";

export interface ExperimentRunUpdate {
  content: [{ type: "text"; text: string }];
  details: {
    phase: "running";
    elapsed: string;
    truncation?: ReturnType<typeof truncateTail>;
    fullOutputPath?: string;
  };
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export interface CapturedOutput {
  output: string;
  tempFilePath: string | undefined;
  actualTotalBytes: number;
  metrics: Map<string, number>;
  outputHash: string;
}

export type OutputStream = "stdout" | "stderr";

export interface OutputCapture {
  handleData(data: Buffer, stream?: OutputStream): void;
  renderUpdate(elapsedMs: number): ExperimentRunUpdate;
  finish(): Promise<CapturedOutput>;
}

export function createOutputCapture(options: {
  getTempFile: () => string;
}): OutputCapture {
  const { getTempFile } = options;
  const metrics = new Map<string, number>();
  const metricCollectors = {
    stdout: createMetricCollector(metrics),
    stderr: createMetricCollector(metrics),
  };
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let chunksBytes = 0;
  const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

  let tempFilePath: string | undefined;
  let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
  let fileFinished: Promise<void> | undefined;
  let fileError: unknown;
  let completion: Promise<CapturedOutput> | undefined;
  let totalBytes = 0;

  let chunksGeneration = 0;
  let cachedGeneration = -1;
  let cachedText = "";

  function getBufferText(): string {
    if (cachedGeneration === chunksGeneration) return cachedText;
    cachedText = Buffer.concat(chunks).toString("utf-8");
    cachedGeneration = chunksGeneration;
    return cachedText;
  }

  return {
    handleData(data: Buffer, stream: OutputStream = "stdout"): void {
      metricCollectors[stream].write(data);
      hash.update(data);
      totalBytes += data.length;

      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        // Attach now so write failures are handled even before finish() is called.
        fileFinished = finished(tempFileStream).catch((error) => { fileError = error; });
        for (const chunk of chunks) tempFileStream.write(chunk);
      }

      if (tempFileStream) tempFileStream.write(data);

      chunks.push(data);
      chunksBytes += data.length;

      if (chunksBytes > maxChunksBytes) {
        while (chunks.length > 0) {
          const first = chunks[0];
          let start = Math.max(0, chunksBytes - maxChunksBytes);
          while (start < first.length && (first[start] & 0xc0) === 0x80) start++;
          if (start === 0) break;
          if (start >= first.length) {
            chunks.shift();
            chunksBytes -= first.length;
          } else {
            // Copy so a short tail does not retain an oversized backing buffer.
            chunks[0] = Buffer.from(first.subarray(start));
            chunksBytes -= start;
            break;
          }
        }
      }

      chunksGeneration++;
    },

    renderUpdate(elapsedMs: number): ExperimentRunUpdate {
      const truncation = truncateTail(getBufferText(), {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return {
        content: [{ type: "text", text: truncation.content || "" }],
        details: {
          phase: "running",
          elapsed: formatElapsed(elapsedMs),
          truncation: truncation.truncated ? truncation : undefined,
          fullOutputPath: tempFilePath,
        },
      };
    },

    finish(): Promise<CapturedOutput> {
      completion ??= (async () => {
        metricCollectors.stdout.finish();
        metricCollectors.stderr.finish();
        const outputHash = `sha256:${hash.digest("hex")}`;
        tempFileStream?.end();
        await fileFinished;
        if (fileError) throw fileError;
        return {
          output: getBufferText(),
          tempFilePath,
          actualTotalBytes: totalBytes,
          metrics,
          outputHash,
        };
      })();
      return completion;
    },
  };
}
