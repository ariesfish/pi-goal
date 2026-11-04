import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  firstTextContent,
  resolveResearchToolContext,
  textToolResult,
} from "./tool-adapter.ts";
import {
  FreezeCriteriaParams,
  FrameGoalParams,
  ProbeGoalParams,
} from "../support/schema.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { cloneResearchState } from "../domain/research-state.ts";
import {
  executeFrameGoal,
  executeFreezeCriteria,
  executeProbeGoal,
  type GoalContractWorkflowResult,
} from "../workflows/goal-contract-workflow.ts";

export interface GoalContractToolDeps {
  exec: Pick<ExtensionAPI, "exec">;
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  broadcastDashboardUpdate(workDir: string): void;
}

export function registerGoalContractTools(pi: ExtensionAPI, deps: GoalContractToolDeps): void {
  const finish = (
    ctx: ExtensionContext,
    workDir: string,
    result: GoalContractWorkflowResult,
  ) => {
    deps.updateWidget(ctx);
    deps.broadcastDashboardUpdate(workDir);
    return textToolResult(
      result.text,
      result.ok ? { state: cloneResearchState(result.state) } : {},
    );
  };

  pi.registerTool({
    name: "frame_goal",
    label: "Frame Goal",
    description:
      "Register at least two orthogonal direction cards before probing. Each card needs a mechanism, proxy metric, cost, risk, and kill condition.",
    promptSnippet: "Frame a goal into orthogonal direction cards",
    promptGuidelines: [
      "Call frame_goal while the phase is framing, before any probe.",
      "Register at least two directions that differ in mechanism, not wording. Each card must name a proxy metric and a kill condition.",
      "After frame_goal, probe every direction with probe_goal. Each probe ends kept or killed with evidence.",
    ],
    parameters: FrameGoalParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) return textToolResult(contextResult.text);
      const { runtime, workDir } = contextResult.context;
      const result = executeFrameGoal(params, {
        runtime,
        workDir,
        confirm: async () => true,
        broadcastDashboardUpdate: deps.broadcastDashboardUpdate,
      });
      return finish(ctx, workDir, result);
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.directions) ? args.directions.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("frame_goal ")) + theme.fg("muted", `${count} directions`),
        0,
        0,
      );
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });

  pi.registerTool({
    name: "probe_goal",
    label: "Probe Direction",
    description:
      "Run one timeboxed probe for a direction, record its value and output hash, and close the direction as kept or killed.",
    promptSnippet: "Probe one direction and record evidence",
    promptGuidelines: [
      "Call probe_goal for every open direction while the phase is probing.",
      "The probe command should emit `METRIC <proxyMetric>=<value>`; pass `value` only when it cannot.",
      "A crashed or timed-out probe is recorded as killed. Every closed direction needs an evidence pointer.",
    ],
    parameters: ProbeGoalParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) return textToolResult(contextResult.text);
      const { runtime, workDir } = contextResult.context;
      const result = await executeProbeGoal(params, {
        runtime,
        workDir,
        confirm: async () => true,
        broadcastDashboardUpdate: deps.broadcastDashboardUpdate,
      });
      return finish(ctx, workDir, result);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("probe_goal ")) + theme.fg("muted", String(args.direction_id ?? "")),
        0,
        0,
      );
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });

  pi.registerTool({
    name: "freeze_criteria",
    label: "Freeze Criteria",
    description:
      "Validate, hash, and freeze the goal contract with the human once. Every blocking criterion needs an executable check; manual criteria cannot block.",
    promptSnippet: "Freeze the goal contract with numbered criteria",
    promptGuidelines: [
      "Call freeze_criteria after all directions are closed.",
      "Provide exactly one blocking metric criterion as the primary target; add guard metrics and semantic checks.",
      "Every blocking criterion needs a check or metric. Manual criteria may only be advisory.",
      "The human confirms once; after that, changing the contract requires a new human decision.",
    ],
    parameters: FreezeCriteriaParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) return textToolResult(contextResult.text);
      const { runtime, workDir } = contextResult.context;
      if (!ctx.hasUI) {
        return textToolResult(
          "❌ freeze_criteria needs one human confirmation. Run pi interactively, freeze the contract, then hand off the sealed loop.",
        );
      }
      const result = await executeFreezeCriteria(params, {
        runtime,
        workDir,
        confirm: (message) => ctx.ui.confirm("Freeze goal contract", message),
        exec: deps.exec,
        broadcastDashboardUpdate: deps.broadcastDashboardUpdate,
      });
      return finish(ctx, workDir, result);
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.criteria) ? args.criteria.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("freeze_criteria ")) + theme.fg("muted", `${count} criteria`),
        0,
        0,
      );
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });
}
