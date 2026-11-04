# pi-goal Domain Context

pi-goal helps an agent run controlled research loops inside a project: choose a research target, run measured attempts, keep improvements, reject regressions, and preserve enough history to resume later.

## Language

**Project**:
A code workspace in which one or more research efforts may be performed.
_Avoid_: repository when the distinction is not about Git storage.

**Research**:
A long-lived optimization or investigation effort within a project, focused on one target and resumable across agent sessions.
_Avoid_: session, experiment session, run group.

**Active Research**:
The single research effort currently selected for a project workspace.
_Avoid_: current session.

**Research Identity**:
The stable identity that distinguishes one research effort from another within the same project.
_Avoid_: experiment name, session id.

**Research Directory**:
The persistent storage location for one research effort's files and journal.
_Avoid_: session folder, runtime directory.

**Research Journal**:
The append-only record of research configuration, protocol entries, and run results.
_Avoid_: session state, runtime state.

**Goal Contract**:
The frozen set of criteria that decides whether a run is kept: one primary metric, optional guard metrics, and an executable check for every blocking criterion. Sealing it requires one human confirmation.
_Avoid_: plan, spec, goal file.

**Criterion**:
One column of the Goal Contract. A criterion is `metric`, `command`, `test`, or `manual`; only non-manual criteria can block.
_Avoid_: check, assertion.

**Gate**:
The deterministic verdict over the Goal Contract and the current workspace: every criterion check, scope check, and test-file protection. The gate, not the model, decides keep or discard.
_Avoid_: review, score.

**Direction**:
One orthogonal way to pursue the goal, with a mechanism, proxy metric, cost, risk, and kill condition.
_Avoid_: option, idea.

**Probe**:
One timeboxed measurement of a Direction. A probe ends kept or killed and carries an evidence pointer.
_Avoid_: experiment, trial.

**Attempt**:
A run that was reverted. Its diff is retained as a patch so the failure remains available as evidence.
_Avoid_: failed run, discard.

**Review Finding**:
One claim from the optional reviewer. A finding blocks only when its repro is executed and fails.
_Avoid_: comment, issue.

**Experiment**:
A comparable measurement phase within a research effort, with its own objective framing, primary metric, direction, workload, measurement method, and baseline.
_Avoid_: run, attempt.

**Experiment Start**:
The act of opening a new experiment inside the active research when future runs are no longer comparable to the current experiment's baseline.
_Avoid_: research initialization, session reset.

**Baseline**:
The first run result in an experiment, used as the comparison point for later runs in that experiment.
_Avoid_: best result.

**Run**:
One measured attempt within an experiment, consisting of a candidate change, benchmark execution, and logged result.
_Avoid_: experiment.

**Run Result**:
The recorded outcome of a run, including metric values, status, description, and diagnostic side information.
_Avoid_: experiment result.

**Metric**:
A numeric measurement used to compare run results.
_Avoid_: score when the direction is ambiguous.

**Primary Metric**:
The metric that decides whether a run improved.
_Avoid_: main score.

**Secondary Metric**:
A metric tracked for tradeoff monitoring but not normally used to decide whether a run is kept.
_Avoid_: auxiliary score.

**Run Status**:
The classification of a run result as kept, discarded, crashed, or rejected by checks.
_Avoid_: result type.

**Actionable Side Information**:
Structured diagnostic context attached to a run result so later runs can learn from it.
_Avoid_: notes, comments.

**Session Runtime**:
The pi session-scoped in-memory state used to control UI, loop progress, in-flight runs, and auto-resume behavior.
_Avoid_: research session, experiment state.

## Relationships

- A **Project** may contain many **Research** efforts.
- A **Project** has at most one **Active Research** at a time.
- A **Research** has one **Research Identity** and one **Research Directory**.
- A **Research Directory** contains one **Research Journal** and an `attempts/` directory of reverted-attempt patches.
- A **Research** has at most one **Goal Contract**; it is frozen before the first baseline run.
- Before a **Goal Contract** exists, a **Research** moves through framing, probing, and converging; each transition is code-enforced.
- A **Gate** evaluates every blocking **Criterion** against a candidate **Run**. A failed gate means the run cannot be kept.
- A **Direction** produces zero or more **Probes**. All Active Research directions close before the contract can be frozen.
- A reverted **Run** produces one **Attempt**; a kept run produces a commit.
- A **Research** contains one or more **Experiments**.
- Initializing a **Research** creates its first **Experiment**.
- An **Experiment Start** creates another **Experiment** within the **Active Research**; it does not create a new **Research**.
- An **Experiment** contains one or more **Runs**.
- The first **Run Result** in an **Experiment** is its **Baseline**.
- A **Run** produces exactly one **Run Result** once logged.
- A **Run Result** belongs to exactly one **Experiment**.
- A **Session Runtime** may cache a view of the **Active Research**, but it is not part of the research domain.

## Example dialogue

> **Dev:** "The user wants to optimize test runtime and later optimize bundle size in the same project. Is that one **Research** with two **Experiments**?"
> **Domain expert:** "No. Those are two **Research** efforts with different **Research Identities**. A new **Experiment** is only for re-initializing the metric or baseline inside one research effort."

> **Dev:** "If the metric changes from `total_ms` to `p95_ms`, is that a new **Run**?"
> **Domain expert:** "No. Start a new **Experiment** inside the same **Research**, and its first **Run Result** becomes the new **Baseline**."

> **Dev:** "Should starting a new **Experiment** be hidden inside research initialization?"
> **Domain expert:** "No. Initializing a **Research** and starting a later **Experiment** are separate actions, even if the first initialization also creates the first **Experiment**."

## Flagged ambiguities

- "session" was used for both **Research** and pi chat/runtime state — resolved: use **Research** for the domain concept and **Session Runtime** for pi-scoped in-memory state.
- "experiment" was used for both a configuration segment and a measured attempt — resolved: **Experiment** is the configuration segment; **Run** is the measured attempt.
- "experiment result" was used for logged run entries — resolved: use **Run Result**.
- "segment" was used for re-initialized experiment scopes — resolved: use **Experiment** in domain language.
- "re-init" was used for both initializing a **Research** and starting another **Experiment** — resolved: use **Experiment Start** for the latter.
- "goal" was used for the user-facing target, the `goal.md` narrative, and the frozen criteria — resolved: **Goal Contract** is the frozen criteria artifact; `goal.md` is narrative only and never parsed for state.
