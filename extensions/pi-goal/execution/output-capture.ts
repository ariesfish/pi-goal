import { createWriteStream } from "node:fs";

import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { formatElapsed, type ExperimentRunUpdate } from "./experiment-runner.ts";

export interface OutputCapture {
  handleData(data: Buffer): void;
  renderUpdate(elapsedMs: number): ExperimentRunUpdate;
  finish(): void;
  output(): string;
  tempFilePath(): string | undefined;
  totalBytes(): number;
}

export function createOutputCapture(options: {
  getTempFile: () => string;
}): OutputCapture {
  const { getTempFile } = options;
  const chunks: Buffer[] = [];
  let chunksBytes = 0;
  const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

  let tempFilePath: string | undefined;
  let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
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
    handleData(data: Buffer): void {
      totalBytes += data.length;

      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) tempFileStream.write(chunk);
      }

      if (tempFileStream) tempFileStream.write(data);

      chunks.push(data);
      chunksBytes += data.length;

      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }

      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a);
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
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

    finish(): void {
      if (tempFileStream) tempFileStream.end();
    },

    output(): string {
      return Buffer.concat(chunks).toString("utf-8");
    },

    tempFilePath(): string | undefined {
      return tempFilePath;
    },

    totalBytes(): number {
      return totalBytes;
    },
  };
}
