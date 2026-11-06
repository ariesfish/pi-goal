# Changelog

## [0.5.3] - 2026-11-06

### Changed

- `hasContract` in the research file contract now reports the legacy Goal Contract derived from a config header, so a journal that predates contract entries no longer reads as "no contract".
- The journal is replayed once and reused while the file is unchanged, instead of re-parsing the whole journal on every turn.

### Fixed

- A kept run whose commit landed but whose journal write failed is reported with the commit hash and a `log_goal` retry instruction, instead of a bare failure that hid the commit.

## [0.5.2] - 2026-11-04

### Added

- Sealed-mode shell write interception: redirection, `tee`, in-place `sed`/`perl`, `cp`/`mv`/`install`, `dd of=`, and `truncate` targeting protected test, benchmark, or research-state paths are blocked. Arbitrary interpreters remain a residual bypass.

### Changed

- Local `goal.config.json` is gitignored; this repository's dogfood config uses the `cfgpu/glm-5-3` reviewer with `thinking: "max"`.

## [0.5.1] - 2026-11-04

### Added

- Reviewer `kind: "pi"`: a separate pi subagent with its own `model`, read-only tools, and an isolated temp cwd containing only `payload.json`. External command reviewers remain available as `kind: "command"`.
- The reviewer payload now includes untracked files.
- `/goal allow-benchmark` and `/goal protect-benchmark`; sealed mode protects `goal.sh` and `goal.checks.sh`.

### Changed

- Checks and narrative files resolve from the research directory first, with a project-root fallback for the default research.
- Compaction is phase-aware: it includes the phase, contract, directions, last gate, and reverted attempts, and is wired into `session_before_compact`.
- The widget and dashboard are visible before the first run and show direction/probe progress; criteria progress counts only contract criteria.
- `run_goal` reports the actual best kept metric instead of the baseline.
- `reviewer` config is read from the session directory, matching the documented location.

### Fixed

- Guard metric criteria compare their own metric and baseline, not the primary.
- Gate and review results update runtime state, so precision and the widget reflect the current session.
- Dashboard escapes status classes and run labels; `run_goal` labels no longer expose raw values.
- Reviewer command stdin EPIPE, browser-opener spawn errors, and hook stdin EPIPE no longer crash the extension.
- `freeze_criteria` explains the headless case instead of failing inside the dialog.
- `finalize.sh` excludes `.goal/` and no longer interpolates paths into `node -e`.

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
