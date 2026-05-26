import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

export const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill goal.checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

export const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this research or experiment (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

export const ValidateResearchParams = Type.Object({
  dry_run: Type.Optional(Type.Boolean({
    description: "Run goal.sh and verify it emits the configured primary METRIC line. Default: true.",
  })),
  timeout_seconds: Type.Optional(Type.Number({
    description: "Dry-run timeout in seconds. Default: 60.",
  })),
});

export const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  metrics: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Number(),
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
  asi: Type.Optional(
    Type.Object({}, {
      additionalProperties: Type.Unknown(),
      description:
        'Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_goal output is merged automatically; use this to add or override fields.',
    })
  ),
});
