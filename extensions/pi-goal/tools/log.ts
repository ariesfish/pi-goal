import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";

import { resolveWorkDir, validateWorkDir } from "../config.ts";
import { formatMetricValue } from "../format.ts";
import type { HookPayload, ResearchSnapshot } from "../hooks.ts";
import { onLogExperiment as controllerOnLogExperiment } from "../loop-controller.ts";
import { researchJournalPath } from "../paths.ts";
import type { SessionRuntime, LogDetails } from "../runtime.ts";
import { LogParams } from "../schema.ts";
import {
  cloneResearchState,
  computeConfidence,
  currentRuns,
  findBaselineMetric,
  findBaselineSecondary,
  isBetter,
  registerSecondaryMetrics,
  type ASI,
  type ResearchState,
  type RunResult,
} from "../research-state.ts";
import { commitKeptExperiment, revertRejectedExperiment } from "../experiment-workspace.ts";

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
    const secondaryMetrics = params.metrics ?? {};

    // Gate: prevent "keep" when last run's checks failed
    if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
      return {
        content: [{
          type: "text",
          text: `❌ Cannot keep — goal.checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
        }],
        details: {},
      };
    }

    // Validate secondary metrics consistency (after first experiment establishes them)
    if (state.secondaryMetrics.length > 0) {
      const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
      const providedNames = new Set(Object.keys(secondaryMetrics));

      // Check for missing metrics
      const missing = [...knownNames].filter((n) => !providedNames.has(n));
      if (missing.length > 0) {
        return {
          content: [{
            type: "text",
            text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
          }],
          details: {},
        };
      }

      // Check for new metrics not yet tracked
      const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
      if (newMetrics.length > 0 && !params.force) {
        return {
          content: [{
            type: "text",
            text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_goal again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
          }],
          details: {},
        };
      }
    }

    // ASI: agent-supplied free-form diagnostics
    const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
      ? params.asi as ASI
      : undefined;

    const runResult: RunResult = {
      commit: params.commit.slice(0, 7),
      metric: params.metric,
      metrics: secondaryMetrics,
      status: params.status,
      description: params.description,
      timestamp: Date.now(),
      experimentIndex: state.currentExperimentIndex,
      confidence: null,
      asi: mergedASI,
    };

    state.results.push(runResult);

    registerSecondaryMetrics(state, secondaryMetrics);

    // Baseline = first run in current experiment
    state.bestMetric = findBaselineMetric(state.results, state.currentExperimentIndex);

    // Compute confidence score (best improvement as multiple of noise floor)
    state.confidence = computeConfidence(state.results, state.currentExperimentIndex, state.bestDirection);
    runResult.confidence = state.confidence;

    // Build response text
    const runCount = currentRuns(state.results, state.currentExperimentIndex).length;
    let text = `Logged #${state.results.length}: ${runResult.status} — ${runResult.description}`;

    if (state.bestMetric !== null) {
      text += `\nBaseline ${state.metricName}: ${formatMetricValue(state.bestMetric, state.metricUnit)}`;
      if (runCount > 1 && params.status === "keep" && params.metric > 0) {
        const delta = params.metric - state.bestMetric;
        const pct = ((delta / state.bestMetric) * 100).toFixed(1);
        const sign = delta > 0 ? "+" : "";
        text += ` | this: ${formatMetricValue(params.metric, state.metricUnit)} (${sign}${pct}%)`;
      }
    }

    // Show secondary metrics
    if (Object.keys(secondaryMetrics).length > 0) {
      const baselines = findBaselineSecondary(state.results, state.currentExperimentIndex, state.secondaryMetrics);
      const parts: string[] = [];
      for (const [name, value] of Object.entries(secondaryMetrics)) {
        const def = state.secondaryMetrics.find((m) => m.name === name);
        const unit = def?.unit ?? "";
        let part = `${name}: ${formatMetricValue(value, unit)}`;
        const bv = baselines[name];
        if (bv !== undefined && state.results.length > 1 && bv !== 0) {
          const d = value - bv;
          const p = ((d / bv) * 100).toFixed(1);
          const s = d > 0 ? "+" : "";
          part += ` (${s}${p}%)`;
        }
        parts.push(part);
      }
      text += `\nSecondary: ${parts.join("  ")}`;
    }

    // Show ASI summary
    if (mergedASI) {
      const asiParts: string[] = [];
      for (const [k, v] of Object.entries(mergedASI)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
      }
      if (asiParts.length > 0) {
        text += `\n📋 ASI: ${asiParts.join(" | ")}`;
      }
    }

    // Show confidence score
    if (state.confidence !== null) {
      const confStr = state.confidence.toFixed(1);
      if (state.confidence >= 2.0) {
        text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
      } else if (state.confidence >= 1.0) {
        text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
      } else {
        text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
      }
    }

    text += `\n(${runCount} runs in current experiment`;
    if (state.runLimit !== null) {
      text += ` / ${state.runLimit} max`;
    }
    text += `)`;

    // Auto-commit only on keep — discards/crashes get reverted anyway
    if (params.status === "keep") {
      const keepResult = await commitKeptExperiment({
        pi,
        workDir,
        description: params.description,
        metricName: state.metricName,
        metric: params.metric,
        status: params.status,
        secondaryMetrics,
      });
      text += keepResult.text;
      if (keepResult.commit) runResult.commit = keepResult.commit;
    }

    const jsonlEntry: Record<string, unknown> = {
      run: state.results.length,
      ...runResult,
    };
    if (!mergedASI) delete jsonlEntry.asi;
    const jsonlLine = JSON.stringify(jsonlEntry);

    try {
      fs.appendFileSync(researchJournalPath(workDir), jsonlLine + "\n");
      deps.broadcastDashboardUpdate(workDir);
    } catch (e) {
      text += `\n⚠️ Failed to write goal.jsonl: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (params.status !== "keep") {
      text += await revertRejectedExperiment({ pi, workDir, status: params.status });
    }

    const afterSteer = await deps.fireHook({
      event: "after",
      cwd: workDir,
      run_entry: jsonlEntry,
      research: deps.buildResearchSnapshot(state),
    });
    if (afterSteer) pi.sendUserMessage(afterSteer, { deliverAs: "steer" });

    const wallClockSeconds = runtime.lastRunDuration;
    runtime.activeRun = null;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;

    const limitReached = state.runLimit !== null && runCount >= state.runLimit;
    controllerOnLogExperiment(runtime.loop, limitReached);
    if (limitReached) {
      text += `\n\n🛑 Maximum runs reached (${state.runLimit}) for the current experiment. STOP the research loop now.`;
      ctx.abort();
    } else if (runtime.loop.mode) {
      const beforeSteer = await deps.fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: jsonlEntry,
        research: deps.buildResearchSnapshot(state),
      });
      if (beforeSteer) pi.sendUserMessage(beforeSteer, { deliverAs: "steer" });
    }

    deps.updateWidget(ctx);

    // Refresh fullscreen overlay if open
    deps.requestOverlayRender();

    return {
      content: [{ type: "text", text }],
      details: {
        runResult: { ...runResult, metrics: { ...runResult.metrics } },
        state: cloneResearchState(state),
        wallClockSeconds,
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
