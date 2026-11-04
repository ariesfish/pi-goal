import type {
  LastRunSummary,
  PromptSnapshot,
  ResearchPhaseState,
  ResearchProtocolOptions,
} from "./research-phase.ts";

export function activationMessage(snapshot: {
  userGoal: string;
  hasConfig: boolean;
  hasRules: boolean;
  hasBenchmarkScript: boolean;
  hasContract?: boolean;
}, options: ResearchProtocolOptions): string {
  if (!snapshot.hasConfig && snapshot.hasContract !== true) {
    return [
      "RESEARCH_FRAMING_REQUIRED",
      "",
      "You are now controlled by the pi-goal extension.",
      "Do not answer conversationally. Do not stop after setup.",
      "",
      `Goal: ${snapshot.userGoal}`,
      "",
      "Mandatory next actions:",
      "1. Read goal.md if it exists and understand the workload.",
      "2. Call frame_goal with at least two orthogonal directions. Each card needs a mechanism, a proxy metric, a cost, a risk, and a kill condition.",
      "3. If the target is already a single clear metric, call init_goal and run the baseline instead of framing.",
      "If information is missing, infer the smallest safe default and proceed.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  return [
    "RESEARCH_RESUME_REQUIRED",
    "",
    "Resume the persisted research.",
    `User context: ${snapshot.userGoal}`,
    "",
    "Required next action:",
    "- Run the next run now using run_goal, then log_goal.",
    "Do not summarize. Do not stop. Do not ask unless blocked by a missing executable command.",
    options.benchmarkGuardrail,
  ].join("\n");
}

export function researchAwaitingLogBlockMessage(state: ResearchPhaseState): string {
  return [
    "❌ Previous run_goal has not been logged.",
    "Call log_goal first before starting another run_goal.",
    "",
    suggestedLogLine(state.lastRun),
  ].filter(Boolean).join("\n");
}

export function composeResearchPhaseResumeMessage(state: ResearchPhaseState, options: ResearchProtocolOptions): string {
  if (state.phase === "framing") {
    return [
      "RESEARCH_FRAMING_REQUIRED",
      "Continue framing now. Read goal.md, then call frame_goal with at least two orthogonal directions.",
      "Each direction needs a mechanism, proxy metric, cost, risk, and kill condition.",
      state.activationPrompt ? `Goal: ${state.activationPrompt}` : "",
      options.benchmarkGuardrail,
    ].filter(Boolean).join("\n");
  }

  if (state.phase === "probing") {
    return [
      "RESEARCH_PROBING_REQUIRED",
      "Probe the open directions now with probe_goal.",
      "Each probe is timeboxed, produces a number or a binary observable, and ends as kept or killed with an evidence pointer.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  if (state.phase === "converging") {
    return [
      "RESEARCH_CONVERGING_REQUIRED",
      "All directions are closed. Converge now.",
      "Call freeze_criteria with one primary metric, guard metrics, and a semantic check for every blocking criterion.",
      "Every blocking criterion must have an executable check; manual criteria cannot block.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  if (state.phase === "needs_init") {
    return [
      "RESEARCH_INIT_REQUIRED",
      "goal.md and goal.sh exist, but the active research has no contract.",
      "Either call frame_goal to explore directions, or call init_goal for a single clear metric, then run the baseline.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  if (state.phase === "needs_baseline") {
    return [
      "RESEARCH_BASELINE_REQUIRED",
      "Research is sealed. Run the experiment baseline now with run_goal.",
      "If goal.sh exists, use `bash goal.sh`.",
      "Then immediately call log_goal.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  if (state.phase === "awaiting_log") {
    return [
      "RESEARCH_LOG_REQUIRED",
      "You just ran a run and must now call log_goal before doing anything else.",
      suggestedLogLine(state.lastRun),
      "Do not run another command before log_goal.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  if (state.phase === "limit_reached") {
    return [
      "RESEARCH_LIMIT_REACHED",
      "The run limit for this experiment is reached. Stop and report the best result.",
      options.benchmarkGuardrail,
    ].join("\n");
  }

  return [
    "RESEARCH_NEXT_RUN_REQUIRED",
    "Run the next measured run now.",
    "Use the persisted research state as needed, pick the most promising hypothesis, then call run_goal + log_goal.",
    options.benchmarkGuardrail,
  ].join("\n");
}

export function composeResearchPhaseCompactionResumeMessage(options: ResearchProtocolOptions): string {
  return [
    "RESEARCH_NEXT_RUN_REQUIRED",
    "Continue the current research phase now.",
    "Read the phase-specific required action from the system prompt, then act on it.",
    "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs.",
    "Do not re-read goal.md or goal.jsonl — the compaction summary already contains them.",
    options.benchmarkGuardrail,
  ].join("\n");
}

export function researchPhaseSystemPromptFor(state: ResearchPhaseState, snapshot: PromptSnapshot, options: ResearchProtocolOptions): string {
  if (!state.mode && !(snapshot.hasRules && snapshot.hasBenchmarkScript && !snapshot.hasConfig)) return "";

  const phase = state.mode ? state.phase : "needs_init";
  const lines = [
    "",
    "## Research Mode (EXTENSION CONTROLLED)",
    "You are in an extension-controlled research loop. Follow the phase-specific required action before doing anything else.",
    `Phase: ${phase}`,
    `Research rules: ${snapshot.mdPath} — read this file at the start of every pi session and after compaction.`,
    "Write promising but deferred optimizations as bullet points to goal.ideas.md — don't let good ideas get lost.",
    options.benchmarkGuardrail,
  ];

  if (phase === "framing") {
    lines.push(
      "Required action: frame the goal. Call frame_goal with at least two orthogonal directions; each card needs mechanism, proxy metric, cost, risk, and kill condition. If the target is already a single clear metric, call init_goal instead.",
    );
  } else if (phase === "probing") {
    lines.push(
      "Required action: probe the open directions. Use probe_goal; each probe ends kept or killed with an evidence pointer.",
    );
  } else if (phase === "converging") {
    lines.push(
      "Required action: converge. Call freeze_criteria with a primary metric, guard metrics, and an executable check for every blocking criterion.",
    );
  } else if (phase === "needs_init") {
    lines.push(
      "Required action: goal files exist but no contract exists. Call frame_goal to explore directions, or init_goal for a single clear metric.",
    );
  } else if (phase === "needs_baseline") {
    lines.push(
      "Required action: run the baseline now with run_goal, then call log_goal.",
    );
  } else if (phase === "awaiting_log") {
    lines.push(
      "Required action: call log_goal for the previous run_goal result before doing anything else.",
      suggestedLogLine(state.lastRun),
      "Do not call run_goal again until log_goal succeeds.",
    );
  } else if (phase === "limit_reached") {
    lines.push(
      "Required action: the run limit is reached. Stop and report the best result.",
    );
  } else if (phase === "sealed") {
    lines.push(
      "Required action: run the next run now with run_goal, then call log_goal. NEVER STOP until interrupted.",
    );
  }

  if (snapshot.hasChecks) {
    lines.push(
      "",
      "## Backpressure Checks (ACTIVE)",
      `${snapshot.checksPath} exists and runs automatically after every passing benchmark in run_goal.`,
      "If the benchmark passes but checks fail, run_goal will report it clearly.",
      "Use status 'checks_failed' in log_goal when this happens — it behaves like a crash (no commit, changes auto-reverted).",
      "You cannot use status 'keep' when checks have failed.",
      "The checks execution time does NOT affect the primary metric.",
    );
  }

  if (snapshot.hasIdeas) {
    lines.push("", `💡 Ideas backlog exists at ${snapshot.ideasPath} — check it for promising experiment paths. Prune stale entries.`);
  }

  return lines.join("\n");
}

function suggestedStatus(lastRun: LastRunSummary | null): "keep" | "discard" | "crash" | "checks_failed" {
  if (!lastRun) return "discard";
  if (lastRun.timedOut || lastRun.crashed || !lastRun.passed) return "crash";
  if (lastRun.checksTimedOut || lastRun.checksPass === false) return "checks_failed";
  return "discard";
}

function suggestedLogLine(lastRun: LastRunSummary | null): string {
  if (!lastRun) return "Suggested next action: call log_goal with the previous run result.";
  const status = suggestedStatus(lastRun);
  const metric = lastRun.parsedPrimary ?? "<metric>";
  const metrics = lastRun.parsedMetrics
    ? Object.entries(lastRun.parsedMetrics)
        .filter(([name]) => name !== lastRun.metricName)
        .map(([name, value]) => `\"${name}\": ${value}`)
        .join(", ")
    : "";
  return `Suggested next action: log_goal({ status: \"${status}\", metric: ${metric}, metrics: {${metrics}}, asi: { \"hypothesis\": \"...\" } })`;
}
