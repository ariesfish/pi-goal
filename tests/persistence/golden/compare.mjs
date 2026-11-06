/**
 * Compare the journal decoder against the golden snapshot.
 *
 *   node --experimental-strip-types tests/persistence/golden/compare.mjs
 *   node --experimental-strip-types tests/persistence/golden/compare.mjs --update
 *
 * A diff means the decoding contract changed. Update the snapshot only with a
 * deliberate decision, and say why in the commit that does it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { replayJournal } from "../../../extensions/pi-goal/persistence/research-state-hydration.ts";
import { corpus } from "./corpus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(here, "expected.json");

/** Key order is an implementation detail; the values are the contract. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function snapshot() {
  const result = {};
  for (const fixture of corpus) {
    const parsed = replayJournal(fixture.journal);
    result[fixture.name] = stable(parsed);
  }
  return result;
}

export function diffSnapshots(expected, actual) {
  const problems = [];
  for (const name of Object.keys(expected)) {
    const want = JSON.stringify(expected[name], null, 2);
    const got = JSON.stringify(actual[name], null, 2);
    if (want !== got) problems.push({ name, want, got });
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) problems.push({ name, want: "(absent)", got: JSON.stringify(actual[name], null, 2) });
  }
  return problems;
}

function main() {
  const actual = snapshot();

  if (process.argv.includes("--update")) {
    fs.writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + "\n");
    console.log(`wrote ${path.relative(process.cwd(), snapshotPath)} (${corpus.length} fixtures)`);
    return;
  }

  const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
  const problems = diffSnapshots(expected, actual);
  if (problems.length === 0) {
    console.log(`golden: ${corpus.length} fixtures match`);
    return;
  }

  for (const problem of problems) {
    console.error(`\n✖ ${problem.name}`);
    console.error(`  expected: ${problem.want}`);
    console.error(`  actual:   ${problem.got}`);
  }
  console.error(`\n${problems.length} fixture(s) changed the decoding contract`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
