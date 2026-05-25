import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import { formatMetricValue } from "../ui/metric-format.ts";
import {
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  isGoalShCommand,
  runExperiment,
  type RunDetails,
} from "../execution/experiment-runner.ts";
import {
  researchAwaitingLogBlockMessage,
  onResearchRunFinished,
  shouldBlockResearchRun,
} from "../protocol/research-phase.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { shouldUseScriptCommandOnly } from "../execution/research-command-policy.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { RunParams } from "../support/schema.ts";
import { currentRuns, type ResearchState } from "../domain/research-state.ts";

export interface RunExperimentToolDeps {
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  requestOverlayRender(): void;
}

export function registerRunExperimentTool(pi: ExtensionAPI, deps: RunExperimentToolDeps): void {
  // -----------------------------------------------------------------------
  // run_goal tool
  // -----------------------------------------------------------------------

  pi.registerTool({
  name: "run_goal",
  label: "Run Experiment",
  description:
    `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any goal experiment.`,
  promptSnippet:
    "Run a timed experiment command (captures duration, output, exit code)",
  promptGuidelines: [
    "Use run_goal instead of bash when running experiment commands — it handles timing and output capture automatically.",
    "After run_goal, always call log_goal to record the result.",
    "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_goal will parse them automatically and suggest exact values for log_goal. Use these parsed values directly instead of extracting them manually from the output.",

  ],
  parameters: RunParams,

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

    if (shouldBlockResearchRun(runtime.loop)) {
      return {
        content: [{ type: "text", text: researchAwaitingLogBlockMessage(runtime.loop) }],
        details: {},
      };
    }

    // Block if max runs limit already reached for the current experiment.
    if (state.runLimit !== null) {
      const runCount = currentRuns(state.results, state.currentExperimentIndex).length;
      if (runCount >= state.runLimit) {
        return {
          content: [{ type: "text", text: `🛑 Maximum runs reached (${state.runLimit}) for the current experiment. To continue with a fresh baseline, call start_goal.` }],
          details: {},
        };
      }
    }

    // Guard: if goal.sh exists, only allow running it
    const fileContract = readResearchFileContract(workDir);
    if (shouldUseScriptCommandOnly(fileContract) && !isGoalShCommand(params.command)) {
      return {
        content: [{
          type: "text",
          text: `❌ goal.sh exists — you must run it instead of a custom command.\n\nFound: ${fileContract.scriptPath}\nYour command: ${params.command}\n\nUse: run_goal({ command: "bash goal.sh" }) or run_goal({ command: "./goal.sh" })`,
        }],
        details: {
          command: params.command,
          exitCode: null,
          durationSeconds: 0,
          passed: false,
          crashed: true,
          timedOut: false,
          tailOutput: "",
          checksPass: null,
          checksTimedOut: false,
          checksOutput: "",
          checksDuration: 0,
          parsedMetrics: null,
          parsedPrimary: null,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
        } as RunDetails,
      };
    }

    // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
    runtime.activeRun = { startedAt: Date.now(), command: params.command };
    deps.updateWidget(ctx);
    deps.requestOverlayRender();

    const { details, llmOutput, truncation: llmTruncation, fullOutputPath } = await runExperiment({
      command: params.command,
      workDir,
      timeoutSeconds: params.timeout_seconds,
      checksTimeoutSeconds: params.checks_timeout_seconds,
      metricName: state.metricName,
      metricUnit: state.metricUnit,
      signal,
      onUpdate,
      pi,
    }).finally(() => {
      runtime.activeRun = null;
      deps.updateWidget(ctx);
      deps.requestOverlayRender();
    });

    runtime.lastRunDuration = details.durationSeconds;
    runtime.lastRunChecks = details.checksPass !== null
      ? { pass: details.checksPass, output: details.checksOutput, duration: details.checksDuration }
      : null;
    onResearchRunFinished(runtime.loop, {
      command: details.command,
      passed: details.passed,
      crashed: details.crashed,
      timedOut: details.timedOut,
      checksPass: details.checksPass,
      checksTimedOut: details.checksTimedOut,
      parsedPrimary: details.parsedPrimary,
      parsedMetrics: details.parsedMetrics,
      metricName: details.metricName,
      metricUnit: details.metricUnit,
    });

    const benchmarkPassed = details.exitCode === 0 && !details.timedOut;
    const checksPass = details.checksPass;
    const checksTimedOut = details.checksTimedOut;
    const checksDuration = details.checksDuration;
    const parsedMetrics = details.parsedMetrics;
    const parsedPrimary = details.parsedPrimary;

    const missingPrimaryMetric = benchmarkPassed && shouldUseScriptCommandOnly(fileContract) && details.parsedPrimary === null;

    // Build LLM response
    let text = "";
    if (details.timedOut) {
      text += `⏰ TIMEOUT after ${details.durationSeconds.toFixed(1)}s\n`;
    } else if (!benchmarkPassed) {
      text += `💥 FAILED (exit code ${details.exitCode}) in ${details.durationSeconds.toFixed(1)}s\n`;
    } else if (missingPrimaryMetric) {
      text += `❌ PRIMARY METRIC MISSING after ${details.durationSeconds.toFixed(1)}s\n`;
      text += `Expected output line: METRIC ${state.metricName}=<number>\n`;
      text += `Parsed metrics: ${details.parsedMetrics ? Object.keys(details.parsedMetrics).join(", ") : "(none)"}\n`;
      text += `Fix goal.sh or call start_goal with the correct metric name. Log this as 'crash' if you cannot fix it in this turn.\n`;
    } else if (checksTimedOut) {
      text += `✅ Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
      text += `⏰ CHECKS TIMEOUT (goal.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
      text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
    } else if (checksPass === false) {
      text += `✅ Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
      text += `💥 CHECKS FAILED (goal.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
      text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
    } else {
      text += `✅ PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
      if (checksPass === true) {
        text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
      }
    }

    if (state.bestMetric !== null) {
      text += `📊 Current best ${state.metricName}: ${formatMetricValue(state.bestMetric, state.metricUnit)}\n`;
    }

    // Show parsed METRIC lines to the LLM
    if (parsedMetrics) {
      const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

      // Human-readable summary
      text += `\n📐 Parsed metrics:`;
      if (parsedPrimary !== null) {
        text += ` ★ ${state.metricName}=${formatMetricValue(parsedPrimary, state.metricUnit)}`;
      }
      for (const [name, value] of secondary) {
        // Infer unit from name suffix for display
        const sm = state.secondaryMetrics.find((m) => m.name === name);
        const unit = sm?.unit ?? "";
        text += ` ${name}=${formatMetricValue(value, unit)}`;
      }

      // Machine-ready values for log_goal (raw numbers, not formatted)
      text += `\nUse these values directly in log_goal (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
    }

    text += `\n${llmOutput}`;

    if (llmTruncation) {
      if (llmTruncation.truncatedBy === "lines") {
        text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
      } else {
        text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
      }
      if (fullOutputPath) {
        text += ` Full output: ${fullOutputPath}`;
      }
      text += `]`;
    }

    if (checksPass === false) {
      text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
    }

    return {
      content: [{ type: "text", text }],
      details: { ...details, truncation: llmTruncation, fullOutputPath },
    };
  },

  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("run_goal "));
    text += theme.fg("muted", args.command);
    if (args.timeout_seconds) {
      text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
    }
    return new Text(text, 0, 0);
  },

  renderResult(result, { expanded, isPartial }, theme) {
    const PREVIEW_LINES = 5;

    if (isPartial) {
      // Streaming: show elapsed timer + tail of output
      const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
      const elapsed = d?.elapsed ?? "";
      const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

      let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

      // Always show tail of streaming output (like bash tool shows preview lines)
      if (outputText) {
        const lines = outputText.split("\n");
        const maxLines = expanded ? 20 : PREVIEW_LINES;
        const tail = lines.slice(-maxLines).join("\n");
        if (tail.trim()) {
          text += "\n" + theme.fg("dim", tail);
        }
      }

      return new Text(text, 0, 0);
    }

    const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
    if (!d) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    }

    // Helper: append tail output preview or full output
    const appendOutput = (text: string, output: string): string => {
      if (!output) return text;
      const lines = output.split("\n");
      if (expanded) {
        text += "\n" + theme.fg("dim", output.slice(-2000));
      } else {
        const tail = lines.slice(-PREVIEW_LINES).join("\n");
        if (tail.trim()) {
          const hidden = lines.length - PREVIEW_LINES;
          if (hidden > 0) {
            text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
          }
          text += "\n" + theme.fg("dim", tail);
        }
      }
      return text;
    };

    if (d.timedOut) {
      let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
      text = appendOutput(text, d.tailOutput);
      return new Text(text, 0, 0);
    }

    // Helper: format parsed primary metric suffix (empty string if not available)
    const parsedSuffix = d.parsedPrimary !== null
      ? theme.fg("accent", `, ${d.metricName}: ${formatMetricValue(d.parsedPrimary, d.metricUnit)}`)
      : "";

    if (d.checksTimedOut) {
      let text =
        theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
        parsedSuffix +
        theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
      text = appendOutput(text, d.checksOutput);
      return new Text(text, 0, 0);
    }

    if (d.checksPass === false) {
      let text =
        theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
        parsedSuffix +
        theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
      text = appendOutput(text, d.checksOutput);
      return new Text(text, 0, 0);
    }

    if (d.crashed) {
      let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
      text = appendOutput(text, d.tailOutput);
      return new Text(text, 0, 0);
    }

    let text = theme.fg("success", "✅ ");

    // Show wall-clock and parsed primary metric together
    const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
    if (d.parsedPrimary !== null) {
      parts.push(`${d.metricName}: ${formatMetricValue(d.parsedPrimary, d.metricUnit)}`);
    }
    text += theme.fg("accent", parts.join(", "));

    if (d.checksPass === true) {
      text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
    }

    if (d.truncation?.truncated && d.fullOutputPath) {
      text += theme.fg("warning", " (truncated)");
    }

    text = appendOutput(text, d.tailOutput);

    if (expanded && d.truncation?.truncated && d.fullOutputPath) {
      if (d.truncation.truncatedBy === "lines") {
        text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
      } else {
        text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
      }
    }

    return new Text(text, 0, 0);
  },
});

}
