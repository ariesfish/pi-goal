# Changelog

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
