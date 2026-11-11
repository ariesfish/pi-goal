<div align="center">

# pi-goal
### Goal protocol for pi: frame, probe, freeze, then run
**[Install](#install)** · **[Usage](#usage)** · **[Protocol](#the-goal-protocol)** · **[Reference](#reference)**

</div>

*pi-goal turns a fuzzy goal into a frozen contract, then runs measured attempts: keep what passes the gate, revert what does not, and keep the failed diff as evidence.*

Use it for measurable work: test speed, bundle size, training loss, build time, Lighthouse scores, or feature work with checks you can run.

---

## Install

```bash
pi install npm:@ariesfish/pi-goal
```

Requires **pi >= 1.5.0** (the `agent_before_settle` boundary drives the loop).

From a checkout instead, without changing your settings:

```bash
pi -e .
```

Or install the checkout itself:

```bash
pi install .
```

`pi list` shows installed packages; `pi update --extensions` picks up a new release.

---

## Usage

### Start a goal

```text
/skill:goal-create
```

The skill asks for, or infers:

- goal
- benchmark command and primary metric
- files in scope
- hard constraints

It creates a goal branch, writes `goal.md` and `goal.sh`, then frames at least two directions, probes each, and freezes the contract before the baseline.

### Run directly with `/goal`

```text
/goal optimize unit test runtime, monitor correctness
/goal model training, run 5 minutes of train.py and track validation loss
```

| Command | Purpose |
|---|---|
| `/goal <text>` | Start or resume goal mode |
| `/goal off` | Leave goal mode; keep persisted files |
| `/goal clear` | Delete `goal.jsonl` and reset state |
| `/goal reinit` | Start a new comparable experiment with a fresh baseline |
| `/goal select <goal-id>` | Switch active research under `.goal/researches/` |
| `/goal allow-tests` | Unlock test-file edits for this research |
| `/goal protect-tests` | Restore the sealed test-file block |
| `/goal allow-benchmark` | Unlock `goal.sh` / `goal.checks.sh` edits |
| `/goal protect-benchmark` | Restore the benchmark-script block |
| `/goal export` | Open the live browser dashboard |

### The loop

```text
edit → run_goal → check_goal → log_goal → keep or revert → repeat
```

`log_goal` runs the gate itself on `keep`, so `check_goal` is optional. A rejected keep writes an attempt patch, resets the worktree to the checkpoint, and tells you what failed.

---

## The goal protocol

```text
inactive → framing → probing → converging → needs_baseline → sealed
```

| Phase | Code-enforced entry condition |
|---|---|
| framing | no frozen contract yet |
| probing | at least two complete direction cards (mechanism, proxy metric, cost, risk, kill condition) |
| converging | every direction closed as kept or killed with an evidence pointer |
| needs_baseline | contract frozen and hashed; every blocking criterion has an executable check |
| sealed | baseline logged; keeps require a passing gate |

A legacy metric-only research hydrates a one-criterion contract and enters `needs_baseline` or `sealed` without migration.

---

## Tools

| Tool | Purpose |
|---|---|
| `frame_goal` | Register at least two orthogonal direction cards and enter probing |
| `probe_goal` | Run one timeboxed probe, record value + output hash, close the direction |
| `freeze_criteria` | Validate, hash, and freeze the contract after one human confirmation |
| `init_goal` | Initialize a single-metric research (fast path) |
| `start_goal` | Open a new comparable experiment with a fresh baseline |
| `run_goal` | Time a command, capture output, parse `METRIC name=value` lines |
| `check_goal` | Run the gate without logging a run |
| `log_goal` | Record the run, enforce the gate, commit keeps, revert rejects |
| `validate_goal` | Check files, metric output, checks, and workspace safety |
| `review_goal` | Run the optional blind reviewer and verify its findings |

---

## The gate

`log_goal` with `status: keep` is rejected unless every blocking criterion passes.

- **Criteria checks** — `exit0`, `stdout_contains`, or `stdout_regex` on a command; metric criteria compare against the experiment baseline.
- **Noise gate** — an improvement below `1.0x` confidence needs `force_keep: true` plus a reason in `asi`.
- **Test protection** — test files matching the contract's `test_globs` cannot change unless `allow_test_edits` is set or the human ran `/goal allow-tests`.
- **Benchmark protection** — `goal.sh` and `goal.checks.sh` are read-only in sealed mode until the human runs `/goal allow-benchmark`.
- **Shell write interception** — sealed mode blocks shell writes to protected paths: redirection (`>`, `>>`), `tee`, in-place `sed`/`perl`, `cp`/`mv`/`install`, `dd of=`, and `truncate`. Arbitrary interpreters (`python -c`, `node -e`) remain a residual bypass; the guard is a speed bump, not a sandbox.
- **Scope** — with `scope_globs`, changed paths outside them fail the gate.
- **Reviewer** — optional; a finding blocks only when its repro is executed and fails, and only with `reviewer.blocking: true`.

Kept commits carry `Gate:` and `Criteria:` trailers so the decision is auditable.

---

## Files used by a loop

Files live under `.goal/researches/<id>/`. For the default research, `goal.md`, `goal.sh`, `goal.checks.sh`, and `goal.ideas.md` also fall back to the project root, so single-research projects can keep them at the top level.

| File | Purpose |
|---|---|
| `goal.md` | Narrative: objective, metric, scope, constraints, learnings |
| `goal.sh` | Benchmark script; emits `METRIC name=value` |
| `goal.jsonl` | Append-only journal: config, contract, directions, probes, gates, reviews, attempts, runs |
| `goal.checks.sh` | Optional correctness checks after a passing benchmark |
| `goal.ideas.md` | Optional backlog of deferred ideas |
| `goal.hooks/` | Optional `before.sh` / `after.sh` scripts |
| `.goal/researches/<id>/attempts/` | Reverted attempt diffs, one patch per run |

---

## Reviewer (optional)

The default reviewer is a **pi subagent** with its own model. Add it to `goal.config.json`:

```json
{
  "reviewer": {
    "kind": "pi",
    "model": "openai/gpt-5.5",
    "thinking": "high",
    "timeoutSeconds": 300,
    "blocking": false
  }
}
```

The subagent runs in an isolated temp directory containing only `payload.json` (diff, untracked files, frozen criteria, last gate, changed paths) with `--tools read --no-extensions --no-skills --no-context-files --no-mcp --no-session`. It cannot edit, run bash, or see the implementer's summary. It must return JSON findings:

```json
{
  "findings": [
    {
      "id": "F1",
      "severity": "blocking",
      "claim": "shared fixture leaks state",
      "repro": { "kind": "command", "payload": "pnpm test -- tests/order.test.ts" }
    }
  ]
}
```

The extension runs every `repro` in the real project. A finding without a repro, or whose repro passes, is advisory. With `blocking: true`, one reproduced blocking finding denies the keep. Precision (`reproduced / blocking`) is reported so you can decide whether the reviewer has earned blocking power.

External command reviewers remain available:

```json
{
  "reviewer": {
    "kind": "command",
    "command": "node",
    "args": ["tools/reviewer.mjs"],
    "timeoutSeconds": 180,
    "blocking": false
  }
}
```

A command reviewer receives the same payload as JSON on stdin and must return the same findings JSON.

---

## Reference

### Benchmark contract

`goal.sh` should exit non-zero on benchmark failure and print the primary metric as:

```text
METRIC total_ms=123.4
```

Metrics are collected independently from stdout and stderr, including lines printed before long logs. Each metric line must fit within 4 KiB (UTF-8, excluding the newline); oversized lines are ignored. Display output is truncated separately, and the complete log is available when the command finishes.

Secondary metrics use the same format:

```text
METRIC bundle_kb=42.1
```

### Backpressure checks

Create executable `goal.checks.sh` to add extra checks after a passing benchmark:

```bash
#!/bin/bash
set -euo pipefail
pnpm test
pnpm typecheck
```

Checks run after a benchmark exits 0. Failures are logged as `checks_failed` and code changes are reverted. The richer per-criterion equivalent is `freeze_criteria`.

### Confidence score

After 3+ runs in an experiment, pi-goal estimates benchmark noise with Median Absolute Deviation (MAD):

```text
confidence = |best improvement| / MAD
```

| Score | Meaning |
|---|---|
| `≥ 2.0x` | likely real improvement |
| `1.0–2.0x` | above noise but marginal |
| `< 1.0x` | within noise; rerun or pass `force_keep` |

### Configuration

Create `goal.config.json` in the pi session directory:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50,
  "reviewer": { "command": "codex", "args": ["exec", "--json"] }
}
```

| Field | Purpose |
|---|---|
| `workingDir` | Override where goal files, commands, and git operations run |
| `maxIterations` | Stop after this many runs until a new experiment starts |
| `reviewer` | Optional blind reviewer (see above) |

### Hooks

Optional executable hooks live in `goal.hooks/`:

| Hook | Fires | Typical use |
|---|---|---|
| `before.sh` | before activation and after each completed run | fetch research, rotate ideas, prime context |
| `after.sh` | after each `log_goal` | append learnings, notify, tag winners |

Hooks receive one JSON object on stdin, write steer text on stdout, timeout after 30s, and append hook entries to `goal.jsonl`.

### UI

- Status widget: `🎯 sealed 12 runs 8 kept │ ★ total_µs: 15,200 (-12.3%) │ 3/4 criteria`
- `Ctrl+Shift+T`: expand/collapse inline dashboard
- `Ctrl+Shift+D`: fullscreen scrollable dashboard
- `/goal export`: live browser dashboard

Override shortcuts in `<agent-dir>/extensions/pi-goal.json`.

---

## Example targets

| Target | Metric | Command |
|---|---|---|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| Training | val loss ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | score ↑ | `lighthouse http://localhost:3000 --output=json` |

## Prerequisites

- pi >= 1.5.0
- an LLM provider API key
- a benchmark command with a numeric metric

## License

MIT
