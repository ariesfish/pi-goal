# Split research initialization from experiment start

We will separate Research initialization from starting a later Experiment. Initializing a Research creates the first Experiment, but subsequent comparable-measurement resets should use an explicit Experiment Start action, surfaced to users as `/goal reinit` and to tools as a separate `start_goal` capability rather than overloading `init_goal`.

## Considered Options

- Keep `init_goal` as both Research initialization and later Experiment re-initialization.
- Split the concepts: initialize Research once, then start additional Experiments explicitly.

## Consequences

Agents and users get a clearer decision point when the primary metric, workload, measurement method, direction, or baseline comparability changes. Later resets are Experiment Starts, not Research initialization; `init_goal` should reject attempts to reuse it after the active research already has runs.
