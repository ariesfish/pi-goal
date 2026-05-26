import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import type { HookPayload } from "../execution/hooks.ts";
import type { ResearchSnapshot } from "../domain/research-snapshot.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { InitParams } from "../support/schema.ts";
import type { ResearchState } from "../domain/research-state.ts";
import { executeExperimentConfigWorkflow } from "../experiment-config-workflow.ts";

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

      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const workDir = resolveWorkDir(ctx.cwd);
      const result = await executeExperimentConfigWorkflow(params, {
        pi,
        runtime,
        workDir,
        ctxCwd: ctx.cwd,
        kind: copy.name,
        title: copy.title,
        fireHook: deps.fireHook,
        readLastRun: deps.readLastRun,
        buildResearchSnapshot: deps.buildResearchSnapshot,
        broadcastDashboardUpdate: deps.broadcastDashboardUpdate,
      });

      deps.updateWidget(ctx);
      if (result.ok && result.steer) pi.sendUserMessage(result.steer, { deliverAs: "steer" });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.ok ? { state: result.state } : {},
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
