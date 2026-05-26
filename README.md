<div align="center">

# pi-goal
### Autonomous experiment loops for pi
**[Install](#install)** · **[Usage](#usage)** · **[Reference](#reference)**

</div>

*pi-goal lets pi try an idea, measure it, keep improvements, revert regressions, and continue from durable state.*

Use it for any measurable optimization target: test speed, bundle size, training loss, build time, Lighthouse score, or custom benchmarks.

---

## Install

```bash
pi install npm:@ariesfish/pi-goal
```

Manual install:

```bash
cp -r extensions/pi-goal ~/.pi/agent/extensions/
cp -r skills/goal-create ~/.pi/agent/skills/
cp -r skills/goal-finalize ~/.pi/agent/skills/
cp -r skills/goal-hooks ~/.pi/agent/skills/
```

Then run `/reload` in pi.

---

## Usage

### Start a loop

```text
/skill:goal-create
```

The skill asks for, or infers:

- goal
- benchmark command
- primary metric and direction
- files in scope
- constraints

It creates a goal branch, writes `goal.md` and `goal.sh`, runs the baseline, then starts iterating.

### Run directly with `/goal`

```text
/goal optimize unit test runtime, monitor correctness
/goal model training, run 5 minutes of train.py and track validation loss
```

Useful subcommands:

| Command | Purpose |
|---|---|
| `/goal <text>` | Start or resume goal mode |
| `/goal off` | Leave goal mode; keep persisted files |
| `/goal clear` | Delete `goal.jsonl` and reset state |
| `/goal reinit` | Start a new comparable experiment with a fresh baseline |
| `/goal select <goal-id>` | Switch active research under `.goal/researches/` |
| `/goal export` | Open the live browser dashboard |

### The loop

pi edits code, commits candidates, calls `run_goal`, then calls `log_goal`:

```text
edit → commit → run_goal → log_goal → keep or revert → repeat
```

Results are appended to `goal.jsonl`. The current plan and learnings live in `goal.md`, so a fresh agent can resume after restarts or context compaction.

### Finalize results

```text
/skill:goal-finalize
```

This reads `goal.jsonl`, groups kept runs into logical changesets, asks for approval, then creates one reviewable branch per group from the merge base.

---

## What it installs

### Extension tools

| Tool | Purpose |
|---|---|
| `init_goal` | Initialize the active research and first experiment |
| `start_goal` | Open a new comparable experiment with a fresh baseline |
| `run_goal` | Time a command, capture output, parse `METRIC name=value` lines |
| `log_goal` | Record the run, keep improvements, revert failures/regressions |
| `validate_goal` | Check goal files, metric output, checks, and workspace safety |

### Skills

| Skill | Purpose |
|---|---|
| `goal-create` | Set up and start an optimization loop |
| `goal-finalize` | Turn a noisy goal branch into clean review branches |
| `goal-hooks` | Help author optional `goal.hooks/before.sh` and `after.sh` scripts |

### Files used by a loop

| File | Purpose |
|---|---|
| `goal.md` | Goal, metric, scope, constraints, attempts, learnings |
| `goal.sh` | Benchmark script; should output `METRIC name=value` |
| `goal.jsonl` | Append-only run journal |
| `goal.checks.sh` | Optional correctness checks after successful benchmarks |
| `goal.ideas.md` | Optional backlog of promising ideas |
| `goal.hooks/` | Optional scripts fired before/after iterations |

---

## UI

- Status widget above the editor: `🎯 goal 12 runs 8 kept │ ★ total_µs: 15,200 (-12.3%) │ conf: 2.1×`
- `Ctrl+Shift+T`: expand/collapse inline dashboard
- `Ctrl+Shift+F`: fullscreen scrollable dashboard
- `/goal export`: live browser dashboard with chart and share card

Override shortcuts in `<agent-dir>/extensions/pi-goal.json`:

```json
{
  "shortcuts": {
    "toggleDashboard": "ctrl+shift+y",
    "fullscreenDashboard": null
  }
}
```

Use `null` to disable a shortcut.

---

## Reference

### Benchmark contract

`goal.sh` should exit non-zero on benchmark failure and print the primary metric as:

```text
METRIC total_ms=123.4
```

Secondary metrics can use the same format:

```text
METRIC bundle_kb=42.1
```

### Backpressure checks

Create executable `goal.checks.sh` to block unsafe keeps:

```bash
#!/bin/bash
set -euo pipefail
pnpm test
pnpm typecheck
```

Checks run after a benchmark exits 0. Their runtime does not affect the primary metric. Failures are logged as `checks_failed` and code changes are reverted.

### Confidence score

After 3+ runs in an experiment, pi-goal estimates benchmark noise with Median Absolute Deviation (MAD):

```text
confidence = |best improvement| / MAD
```

| Score | Meaning |
|---|---|
| `≥ 2.0×` | likely real improvement |
| `1.0–2.0×` | above noise but marginal |
| `< 1.0×` | within noise; rerun to confirm |

The score is advisory. It never auto-discards.

### Configuration

Create `goal.config.json` in the pi session directory:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Purpose |
|---|---|
| `workingDir` | Override where goal files, commands, and git operations run |
| `maxIterations` | Stop after this many runs until a new experiment is started |

### Hooks

Optional executable hooks live in `goal.hooks/`:

| Hook | Fires | Typical use |
|---|---|---|
| `before.sh` | before activation and after each completed run | fetch research, rotate ideas, prime context |
| `after.sh` | after each `log_goal` | append learnings, notify, tag winners |

Hooks receive one JSON object on stdin, write steer text on stdout, timeout after 30s, and append hook entries to `goal.jsonl`. See [`skills/goal-hooks/examples/`](skills/goal-hooks/examples/) for complete scripts.

---

## Example targets

| Target | Metric | Command |
|---|---|---|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| Training | val loss ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | score ↑ | `lighthouse http://localhost:3000 --output=json` |

---

## Prerequisites

- pi installed and configured
- an LLM provider API key
- a benchmark command with a numeric metric

Goal loops can run for a long time. Use provider-side budgets and `maxIterations` to cap cost.

## License

MIT
