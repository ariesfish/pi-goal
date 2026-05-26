import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import {
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  type RunDetails,
} from "../execution/experiment-runner.ts";
import {
  renderRunExperimentPartialText,
  renderRunExperimentResultText,
} from "../ui/run-result-renderer.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { RunParams } from "../support/schema.ts";
import { executeRunExperimentWorkflow } from "../workflows/research-workflow.ts";

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
    const result = await executeRunExperimentWorkflow(params, {
      pi,
      workDir,
      runtime,
      signal,
      onUpdate,
      onActiveRunChange() {
        deps.updateWidget(ctx);
        deps.requestOverlayRender();
      },
    });

    return {
      content: [{ type: "text", text: result.text }],
      details: result.ok ? result.details : result.details ?? {},
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
    if (isPartial) {
      // Streaming: show elapsed timer + tail of output
      const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
      const elapsed = d?.elapsed ?? "";
      const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

      return new Text(renderRunExperimentPartialText({ outputText, elapsed, expanded, theme }), 0, 0);
    }

    const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
    if (!d) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    }

    return new Text(renderRunExperimentResultText({ details: d, expanded, theme }), 0, 0);
  },
});

}
