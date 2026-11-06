# Keep hand-written journal validation

The Research Journal decoder (`persistence/research-journal-codec.ts`) validates
and normalizes nine entry types by hand. We tried replacing it with
`@earendil-works/pi-schema` and did not ship it: the schema version measured 509
lines against the current 454, because schemas replaced only the all-or-nothing
required-field checks (~40 lines) while the tolerant defaults — the part that
actually matters — still needed hand-written readers.

## Considered Options

- Declare the required core of each entry as a JSON Schema (pi-schema), keep
  hand-written readers for optional fields.
- Keep the hand-written decoder and pin its behaviour with a golden corpus.
- Validate the whole entry strictly and reject anything unexpected.

## Decision

Keep the hand-written decoder. Pin its behaviour with
`tests/persistence/golden/` (31 fixtures and a snapshot of the decoded state).

Strict whole-entry validation was rejected because it changes what the journal
means: the decoder must never throw and must keep salvaging what it can, since
the journal is the only durable record of a research. Strictness there loses
runs that a reader could still interpret.

## Consequences

- `tests/persistence/golden/expected.json` is the decoding contract. A diff is
  either a deliberate, explained behaviour change or a regression.
- The decoder stays the largest file in `persistence/`; its size comes from
  tolerance, which is a feature, not from duplication.
- Tool parameter schemas still use TypeBox, because pi's `registerTool` types
  `parameters` as a TypeBox `TSchema`. `@earendil-works/pi-schema` is not a
  dependency of this package.
- A future attempt should start from the golden corpus: any rewrite must
  reproduce `expected.json` byte for byte before it is considered.
