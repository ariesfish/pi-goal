# Changelog

## [0.5.0] - 2026-11-04

### Added

- Phased goal protocol: framing, probing, converging, and sealed, with code-enforced transitions.
- Goal Contract: metric/command/test/manual criteria, scope globs, test protection, frozen hash, and one human confirmation.
- New tools: `frame_goal`, `probe_goal`, `freeze_criteria`, `check_goal`, and `review_goal`.
- Deterministic gate for keeps: criteria checks, noise gate, scope check, test-file protection, and commit trailers.
- Rejected runs reset to the checkpoint and retain their diff under `.goal/researches/<id>/attempts/`.
- Optional blind reviewer: diff + criteria + gate in, structured findings out, every repro executed before it can block. Precision is reported.
- `/goal allow-tests` and `/goal protect-tests` persist a policy entry in the journal.
- `reviewer` configuration and an attempt directory per research.
- Status widget shows the phase and blocking-criteria progress.

### Changed

- Loop continuation uses pi's `agent_before_settle` boundary instead of `agent_end` plus a timer.
- Guards stop the loop after 200 auto-resume turns, 10 consecutive failures, or 8 rounds without a kept improvement.
- `init_goal` writes a one-criterion contract; `start_goal` is rejected on a multi-criterion frozen contract.
- Kept commits exclude `.goal/` and carry `Gate:` and `Criteria:` trailers.

### Breaking

- Requires pi >= 1.5.0.
- Tool schemas use typebox v1 (`typebox` peer instead of `@sinclair/typebox`).

## [0.4.0] - 2026-05-26

### Changed

- Consolidated pi-goal's main Research workflow into `extensions/pi-goal/workflows/research-workflow.ts`.
- Removed the old root-level workflow modules and updated tools/tests to import the unified workflow module directly.

## [0.3.0] - 2026-05-26

### Changed

- Publish workflow now runs only on `v*.*.*` version tags or manual dispatch.
- CI now runs on every push and pull request to `main`.
- Updated GitHub Actions to Node 24-compatible major versions.
- Removed publish workflow pnpm cache to avoid skipped-install cache path warnings.

## [0.2.0] - 2026-05-26

### Changed

- Renamed the npm package to `@ariesfish/pi-goal`.
- Organized the node test suite into focused subdirectories.
- Added integration workflow tests for Research initialization, Experiment Starts, Run Result logging, hydration, and multi-Research isolation.
- Added `test:finalize` coverage to CI for finalize script behavior.

## [0.1.0] - 2026-05-26

### Added

- Initial `pi-goal` package for controlled optimization research loops in pi.
- Goal extension tools: `init_goal`, `start_goal`, `run_goal`, `log_goal`, and `validate_goal`.
- Active Research support with isolated Research Directories under `.goal/researches/`.
- Experiment Start support for new baselines within an existing Research.
- Durable Research Journal parsing, hydration, compaction summaries, and dashboard rendering.
- Goal skills for creating loops, finalizing kept runs into review branches, and authoring hooks.
- CI coverage for the node test suite and finalize script tests.
