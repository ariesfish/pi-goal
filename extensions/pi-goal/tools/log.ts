import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import { formatMetricValue } from "../ui/metric-format.ts";
import type { HookPayload, ResearchSnapshot } from "../execution/hooks.ts";
import { onResearchRunLogged as controllerOnLogExperiment } from "../protocol/research-phase.ts";
import type { SessionRuntime, LogDetails } from "../support/runtime.ts";
import { LogParams } from "../support/schema.ts";
import {
  cloneResearchState,
  isBetter,
  type ResearchState,
} from "../domain/research-state.ts";
import { logRunResult } from "../run-logging.ts";

export interface LogExperimentToolDeps {
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  requestOverlayRender(): void;
  broadcastDashboardUpdate(workDir: string): void;
  fireHook(payload: HookPayload): Promise<string | null>;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
}

export function registerLogExperimentTool(pi: ExtensionAPI, deps: LogExperimentToolDeps): void {
  // -----------------------------------------------------------------------
  // log_goal tool
  // -----------------------------------------------------------------------

  pi.registerTool({
  name: "log_goal",
  label: "Log Experiment",
  description:
    "Record a run result. Tracks metrics, updates the status widget and dashboard. Call after every run_goal.",
  promptSnippet:
    "Log run result (commit, metric, status, description)",
  promptGuidelines: [
    "Always call log_goal after run_goal to record the result.",
    "log_goal automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (goal files are preserved). Do NOT commit or revert manually.",
    "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
    "log_goal reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
    "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to goal.ideas.md. Don't let good ideas get lost.",
    "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
  ],
  parameters: LogParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const runtime = deps.getRuntime(ctx);
    const state = runtime.state;

    // Validate working directory exists
    const workDirError = validateWorkDir(ctx.cwd);
    if (workDirError) {
      return {
        content: [{ type: "text", text: `❌ ${workDirError}` }],
        details: {},
      };
    }
    const workDir = resolveWorkDir(ctx.cwd);
    const result = await logRunResult(params, {
      pi,
      workDir,
      state,
      lastRunChecks: runtime.lastRunChecks,
      wallClockSeconds: runtime.lastRunDuration,
      fireHook: deps.fireHook,
      buildResearchSnapshot: deps.buildResearchSnapshot,
      broadcastDashboardUpdate: deps.broadcastDashboardUpdate,
    });

    if (!result.ok) {
      return {
        content: [{ type: "text", text: result.text }],
        details: {},
      };
    }

    let text = result.text;
    if (result.afterSteer) pi.sendUserMessage(result.afterSteer, { deliverAs: "steer" });

    runtime.activeRun = null;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;

    controllerOnLogExperiment(runtime.loop, result.limitReached);
    if (result.limitReached) {
      text += `\n\n🛑 Maximum runs reached (${state.runLimit}) for the current experiment. STOP the research loop now.`;
      ctx.abort();
    } else if (runtime.loop.mode && result.beforeSteer) {
      pi.sendUserMessage(result.beforeSteer, { deliverAs: "steer" });
    }

    deps.updateWidget(ctx);

    // Refresh fullscreen overlay if open
    deps.requestOverlayRender();

    return {
      content: [{ type: "text", text }],
      details: {
        runResult: { ...result.runResult, metrics: { ...result.runResult.metrics } },
        state: cloneResearchState(state),
        wallClockSeconds: result.wallClockSeconds,
      } as LogDetails,
    };
  },

  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("log_goal "));
    const color =
      args.status === "keep"
        ? "success"
        : args.status === "crash" || args.status === "checks_failed"
          ? "error"
          : "warning";
    text += theme.fg(color, args.status);
    text += " " + theme.fg("dim", args.description);
    return new Text(text, 0, 0);
  },

  renderResult(result, _options, theme) {
    const d = result.details as LogDetails | undefined;
    if (!d) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    }

    const { runResult: exp, state: s } = d;
    const color =
      exp.status === "keep"
        ? "success"
        : exp.status === "crash" || exp.status === "checks_failed"
          ? "error"
          : "warning";
    const icon =
      exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

    let text =
      theme.fg(color, `${icon} `) +
      theme.fg("accent", `#${s.results.length}`);

    // Show wall-clock and primary metric together
    const metricParts: string[] = [];
    if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
      metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
    }
    if (exp.metric > 0) {
      metricParts.push(`${s.metricName}: ${formatMetricValue(exp.metric, s.metricUnit)}`);
    }
    if (metricParts.length > 0) {
      text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
    }

    text += " " + theme.fg("muted", exp.description);

    // Show best metric for context (overall best, not just this run)
    if (s.bestMetric !== null) {
      // Find the actual best kept metric in the current experiment
      let best = s.bestMetric;
      for (const r of s.results) {
        if (r.experimentIndex === s.currentExperimentIndex && r.status === "keep" && r.metric > 0) {
          if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
        }
      }
      text +=
        theme.fg("dim", " │ ") +
        theme.fg("warning", `★ best: ${formatMetricValue(best, s.metricUnit)}`);
    }

    // Show secondary metrics inline
    if (Object.keys(exp.metrics).length > 0) {
      const parts: string[] = [];
      for (const [name, value] of Object.entries(exp.metrics)) {
        const def = s.secondaryMetrics.find((m) => m.name === name);
        parts.push(`${name}=${formatMetricValue(value, def?.unit ?? "")}`);
      }
      text += theme.fg("dim", `  ${parts.join(" ")}`);
    }

    return new Text(text, 0, 0);
  },
});

}
