# Research identity and active research

A project may contain multiple long-lived Research efforts because users often optimize different targets in the same working directory, such as test runtime and bundle size. We will model those targets as separate Research efforts with stable Research Identities and Research Directories, while a project has at most one Active Research selected at a time; re-initializing within a Research starts a new Experiment, not a new Research.

## Considered Options

- Multiple Research efforts per project, with one Active Research at a time.
- A single Research per project, with different targets represented as Experiments.

## Consequences

Different optimization targets do not share a journal, baseline, dashboard history, or resume context by accident. Future work that adds research selection must route reads and writes through the Active Research, while Experiment remains the name for a metric/baseline configuration segment inside one Research.
