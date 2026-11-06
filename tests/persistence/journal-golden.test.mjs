import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { replayJournal } from "../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { corpus } from "./golden/corpus.mjs";
import { diffSnapshots, snapshot } from "./golden/compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  fs.readFileSync(path.join(here, "golden", "expected.json"), "utf-8"),
);

test("the decoder matches the golden snapshot for every fixture", () => {
  const problems = diffSnapshots(expected, snapshot());
  assert.deepEqual(
    problems.map((problem) => problem.name),
    [],
    "decoding contract changed — run tests/persistence/golden/compare.mjs and explain the diff",
  );
});

test("every fixture decodes without throwing", () => {
  for (const fixture of corpus) {
    assert.doesNotThrow(
      () => replayJournal(fixture.journal),
      `fixture threw: ${fixture.name}`,
    );
  }
});

test("hostile input never throws and never lands in state", () => {
  const hugeLine = JSON.stringify({
    run: 1,
    commit: "x".repeat(1_000_000),
    metric: 1,
    status: "keep",
    description: "huge",
    timestamp: 0,
    experimentIndex: 0,
  });
  const inputs = {
    "1MB single line": hugeLine + "\n",
    "NUL bytes": '{"type":"config"}\u0000\n{"run":1}\u0000\n',
    "deeply nested json": `{"type":"contract","contract":${"[".repeat(200)}${"]".repeat(200)}}\n`,
    "huge numbers": '{"run":1,"metric":1e308,"timestamp":1e308}\n',
    "only newlines": "\n".repeat(1000),
  };

  for (const [name, text] of Object.entries(inputs)) {
    let parsed;
    assert.doesNotThrow(() => {
      parsed = replayJournal(text);
    }, `${name} threw`);
    assert.ok(parsed.state, `${name} returned no state`);
  }
});
