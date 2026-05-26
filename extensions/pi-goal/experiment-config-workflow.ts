import * as fs from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HookPayload } from "./execution/hooks.ts";
import type { ResearchSnapshot } from "./domain/research-snapshot.ts";
import { readRunLimit } from "./persistence/goal-config.ts";
import { ensureActiveResearch } from "./persistence/research-directory.ts";
import { onResearchInitialized } from "./protocol/research-phase.ts";
import type { SessionRuntime } from "./support/runtime.ts";
import {
  checkResearchWorkspace,
  formatWorkspaceSafetyError,
} from "./workspace/research-workspace.ts";
import { cloneResearchState, type ResearchState } from "./domain/research-state.ts";

export type ExperimentConfigKind = "init_goal" | "start_goal";

export interface ExperimentConfigParams {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: string;
}

export interface ExperimentConfigWorkflowDeps {
  pi: Pick<ExtensionAPI, "exec">;
  runtime: SessionRuntime;
  workDir: string;
  ctxCwd: string;
  kind: ExperimentConfigKind;
  title: string;
  fireHook(payload: HookPayload): Promise<string | null>;
  readLastRun(workDir: string): Record<string, unknown> | null;
  buildResearchSnapshot(state: ResearchState): ResearchSnapshot;
  broadcastDashboardUpdate(workDir: string): void;
}

export interface ExperimentConfigWorkflowBlocked {
  ok: false;
  text: string;
}

export interface ExperimentConfigWorkflowSuccess {
  ok: true;
  text: string;
  state: ResearchState;
  steer: string | null;
}

export type ExperimentConfigWorkflowResult =
  | ExperimentConfigWorkflowBlocked
  | ExperimentConfigWorkflowSuccess;

export async function executeExperimentConfigWorkflow(
  params: ExperimentConfigParams,
  deps: ExperimentConfigWorkflowDeps,
): Promise<ExperimentConfigWorkflowResult> {
  const { runtime, workDir, ctxCwd, kind } = deps;
  const state = runtime.state;
  const startsLaterExperiment = state.results.length > 0;

  if (kind === "init_goal" && startsLaterExperiment) {
    return {
      ok: false,
      text: "❌ init_goal initializes the active research and first experiment only. The active research already has runs; use start_goal to open a new experiment with a fresh baseline.",
    };
  }

  const dirtyCheck = await checkResearchWorkspace(deps.pi, workDir);
  const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
  if (dirtyBlock) {
    return { ok: false, text: `❌ ${dirtyBlock}` };
  }

  applyExperimentConfigState(state, params, startsLaterExperiment, ctxCwd);

  const journalError = writeExperimentConfig(workDir, state);
  if (journalError) {
    return { ok: false, text: journalError };
  }
  deps.broadcastDashboardUpdate(workDir);

  const wasInactive = !runtime.loop.mode;
  onResearchInitialized(runtime.loop);

  let steer: string | null = null;
  if (wasInactive) {
    steer = await deps.fireHook({
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: deps.readLastRun(workDir),
      research: deps.buildResearchSnapshot(state),
    });
  }

  return {
    ok: true,
    text: experimentConfigSuccessText({
      state,
      title: deps.title,
      startsLaterExperiment,
      workDir,
      ctxCwd,
    }),
    state: cloneResearchState(state),
    steer,
  };
}

function applyExperimentConfigState(
  state: ResearchState,
  params: ExperimentConfigParams,
  startsLaterExperiment: boolean,
  ctxCwd: string,
): void {
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
  state.runLimit = readRunLimit(ctxCwd);
}

function writeExperimentConfig(workDir: string, state: ResearchState): string | null {
  try {
    const jsonlPath = ensureActiveResearch(workDir).paths.journal;
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
    return null;
  } catch (error) {
    return `⚠️ Failed to write goal.jsonl: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function experimentConfigSuccessText(options: {
  state: ResearchState;
  title: string;
  startsLaterExperiment: boolean;
  workDir: string;
  ctxCwd: string;
}): string {
  const { state, title, startsLaterExperiment, workDir, ctxCwd } = options;
  const experimentStartNote = startsLaterExperiment
    ? " (new experiment started — previous runs archived, new baseline needed)"
    : "";
  const limitNote = state.runLimit !== null
    ? `\nRun limit: ${state.runLimit} (from goal.config.json)`
    : "";
  const workDirNote = workDir !== ctxCwd ? `\nWorking directory: ${workDir}` : "";
  return `✅ ${title}: "${state.name}"${experimentStartNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to goal.jsonl. Now run the baseline with run_goal.`;
}
