import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { createOutputCapture } from "../../extensions/pi-goal/execution/output-capture.ts";

test("output capture bounds the display tail even for a single oversized line", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  capture.handleData(Buffer.alloc(DEFAULT_MAX_BYTES * 6, "x"));
  const result = await capture.finish();

  assert.ok(Buffer.byteLength(result.output) <= DEFAULT_MAX_BYTES * 2);
  assert.equal(result.actualTotalBytes, DEFAULT_MAX_BYTES * 6);
});

test("output capture preserves split UTF-8 metrics and the last valid value", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  const output = Buffer.from([
    "METRIC latency_µs=12.5\r\n",
    "METRIC __proto__=1\n",
    "METRIC latency_µs=NaN\n",
    "METRIC latency_µs=10\n",
    "METRIC guard=3",
  ].join(""));
  for (const byte of output) capture.handleData(Buffer.from([byte]));

  const result = await capture.finish();
  assert.deepEqual(Object.fromEntries(result.metrics), { latency_µs: 10, guard: 3 });
  assert.equal(result.output, output.toString("utf8"));
  assert.equal(await capture.finish(), result);
});

test("output capture parses stdout and stderr metrics independently", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  capture.handleData(Buffer.from("METRIC total_"), "stdout");
  capture.handleData(Buffer.from("diagnostic\nMETRIC guard=3\n"), "stderr");
  capture.handleData(Buffer.from("ms=12\n"), "stdout");

  const result = await capture.finish();
  assert.deepEqual(Object.fromEntries(result.metrics), { guard: 3, total_ms: 12 });
  assert.equal(result.output, "METRIC total_diagnostic\nMETRIC guard=3\nms=12\n");
});

test("output capture ignores oversized metric lines and resumes at the next line", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  capture.handleData(Buffer.from("METRIC " + "x".repeat(8192) + "=1\nMETRIC total_ms=7\n"));

  const result = await capture.finish();
  assert.deepEqual(Object.fromEntries(result.metrics), { total_ms: 7 });
});

test("output capture trims oversized UTF-8 output on a character boundary", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  capture.handleData(Buffer.from("测".repeat(DEFAULT_MAX_BYTES)));

  const result = await capture.finish();
  assert.ok(Buffer.byteLength(result.output) <= DEFAULT_MAX_BYTES * 2);
  assert.equal(result.output.includes("\ufffd"), false);
});

test("output capture trims UTF-8 safely when eviction ends at a chunk boundary", async () => {
  const capture = createOutputCapture({ getTempFile: () => "/dev/null" });
  const output = Buffer.from("测".repeat(DEFAULT_MAX_BYTES));
  capture.handleData(output.subarray(0, DEFAULT_MAX_BYTES));
  capture.handleData(output.subarray(DEFAULT_MAX_BYTES));

  const result = await capture.finish();
  assert.ok(Buffer.byteLength(result.output) <= DEFAULT_MAX_BYTES * 2);
  assert.equal(result.output.includes("\ufffd"), false);
});

test("output capture reports archive write errors through finish", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-capture-error-"));
  const capture = createOutputCapture({ getTempFile: () => path.join(directory, "missing", "output.log") });
  try {
    capture.handleData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
    await assert.rejects(capture.finish(), { code: "ENOENT" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("output capture finishes writing the complete archive before returning", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-goal-capture-"));
  const logPath = path.join(directory, "output.log");
  const output = Buffer.from("first line\n" + "output\n".repeat(100000) + "last line\n");
  const capture = createOutputCapture({ getTempFile: () => logPath });
  try {
    for (let offset = 0; offset < output.length; offset += 8192) {
      capture.handleData(output.subarray(offset, offset + 8192));
    }
    const result = await capture.finish();

    assert.deepEqual(fs.readFileSync(logPath), output);
    assert.equal(result.tempFilePath, logPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
