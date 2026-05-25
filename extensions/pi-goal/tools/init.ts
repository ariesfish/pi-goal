import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";

import { readRunLimit, resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../workspace/research-workspace.ts";
import type { HookPayload, ResearchSnapshot } from "../execution/hooks.ts";
import { onResearchInitialized as controllerOnInitExperiment } from "../protocol/research-phase.ts";
import { ensureResearchJournalPath } from "../persistence/research-paths.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { InitParams } from "../support/schema.ts";
import { cloneResearchState, type ResearchState } from "../domain/research-state.ts";

export interface InitExperimentToolDeps {
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  broadcastDashboardUpdate(workDir: string): void;
  fireHook(payload: HookPayload): Promise<string | null>;
  readLastRun(workDir: string): Record<string, unknown> | null;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
}

export function registerInitExperimentTool(pi: ExtensionAPI, deps: InitExperimentToolDeps): void {
  registerExperimentConfigTool(pi, deps, {
    name: "init_goal",
    label: "Init Research",
    description:
      "Initialize the active research and create its first experiment. Call once before the first run_goal to set the name, primary metric, unit, and direction. Writes the config header to goal.jsonl.",
    promptSnippet:
      "Initialize active research and first experiment (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_goal exactly once at the start of an research effort, before the first run_goal.",
      "If the active research already has run results, prefer start_goal to open a new experiment with a fresh baseline.",
      "If the optimization target changes, create or select a different research effort instead of starting another experiment.",
    ],
    title: "Research initialized",
  });
}

export function registerStartExperimentTool(pi: ExtensionAPI, deps: InitExperimentToolDeps): void {
  registerExperimentConfigTool(pi, deps, {
    name: "start_goal",
    label: "Start Experiment",
    description:
      "Start a new experiment inside the active research when future runs need a fresh baseline because the metric, direction, workload, measurement method, or baseline comparability changed.",
    promptSnippet:
      "Start a new experiment in the active research with a fresh baseline",
    promptGuidelines: [
      "Use start_goal when the active research keeps the same target but needs a new comparable measurement phase.",
      "Start a new experiment when the primary metric, direction, benchmark workload, measurement method, or baseline comparability changes.",
      "Do not use start_goal for a new optimization target; that should be a different research effort.",
    ],
    title: "Experiment started",
  });
}

interface ExperimentConfigToolCopy {
  name: "init_goal" | "start_goal";
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  title: string;
}

function registerExperimentConfigTool(
  pi: ExtensionAPI,
  deps: InitExperimentToolDeps,
  copy: ExperimentConfigToolCopy,
): void {
  pi.registerTool({
    name: copy.name,
    label: copy.label,
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    promptGuidelines: copy.promptGuidelines,
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = deps.getRuntime(ctx);
      const state = runtime.state;

      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const startsLaterExperiment = state.results.length > 0;
      if (copy.name === "init_goal" && startsLaterExperiment) {
        return {
          content: [{
            type: "text",
            text: "❌ init_goal initializes the active research and first experiment only. The active research already has runs; use start_goal to open a new experiment with a fresh baseline.",
          }],
          details: {},
        };
      }

      const workDir = resolveWorkDir(ctx.cwd);
      const dirtyCheck = await checkResearchWorkspace(pi, workDir);
      const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
      if (dirtyBlock) {
        return {
          content: [{ type: "text", text: `❌ ${dirtyBlock}` }],
          details: {},
        };
      }

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }
      if (startsLaterExperiment) {
        state.currentExperimentIndex++;
      }
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;
      state.runLimit = readRunLimit(ctx.cwd);

      try {
        const jsonlPath = ensureResearchJournalPath(workDir);
        const config = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (fs.existsSync(jsonlPath)) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
        deps.broadcastDashboardUpdate(workDir);
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Failed to write goal.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          }],
          details: {},
        };
      }

      const wasInactive = !runtime.loop.mode;
      controllerOnInitExperiment(runtime.loop);
      deps.updateWidget(ctx);

      if (wasInactive) {
        const steer = await deps.fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: deps.readLastRun(workDir),
          research: deps.buildResearchSnapshot(state),
        });
        if (steer) pi.sendUserMessage(steer, { deliverAs: "steer" });
      }

      const experimentStartNote = startsLaterExperiment ? " (new experiment started — previous runs archived, new baseline needed)" : "";
      const limitNote = state.runLimit !== null ? `\nRun limit: ${state.runLimit} (from goal.config.json)` : "";
      const workDirNote = workDir !== ctx.cwd ? `\nWorking directory: ${workDir}` : "";
      return {
        content: [{
          type: "text",
          text: `✅ ${copy.title}: "${state.name}"${experimentStartNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to goal.jsonl. Now run the baseline with run_goal.`,
        }],
        details: { state: cloneResearchState(state) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold(`${copy.name} `));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });
}
