# Changelog

## [0.1.0] - 2026-05-26

### Added

- Initial `pi-goal` package for controlled optimization research loops in pi.
- Goal extension tools: `init_goal`, `start_goal`, `run_goal`, `log_goal`, and `validate_goal`.
- Active Research support with isolated Research Directories under `.goal/researches/`.
- Experiment Start support for new baselines within an existing Research.
- Durable Research Journal parsing, hydration, compaction summaries, and dashboard rendering.
- Goal skills for creating loops, finalizing kept runs into review branches, and authoring hooks.
- CI coverage for the node test suite and finalize script tests.
