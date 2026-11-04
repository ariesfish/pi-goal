# Phased goal protocol with deterministic gates

A fuzzy goal cannot be optimized directly. The agent first frames at least two orthogonal directions, probes each with a measured command, and converges the evidence into a frozen Goal Contract: one primary metric, guard metrics, and a semantic check for every blocking criterion. Only then does the transactional run loop start. Phase transitions are enforced in code, not requested in prompts, because a prompt-level phase is advisory and drifts under pressure.

The gate, not the model, decides whether a run is kept. Criteria checks, scope checks, and test-file protection are executable; the optional reviewer only produces findings, and each finding's repro is executed before it can block. This keeps verdicts reproducible and lets the reviewer's precision be measured rather than assumed.

## Considered Options

- Keep the single-metric loop and rely on the agent to explore first.
- Let an independent model judge whether the work is complete.
- Add a phased protocol whose transitions and keep/discard verdicts are code-enforced.

## Consequences

- Setup costs more before the first run, and the operator approves the contract once.
- Legacy metric-only research hydrates a one-criterion contract, so old journals keep working.
- Reviewers are opt-in and advisory by default; enabling `reviewer.blocking` trades false negatives for reviewer latency and false positives.
- Failed attempts are reverted to the checkpoint but their diffs are retained, so exploration evidence survives.
