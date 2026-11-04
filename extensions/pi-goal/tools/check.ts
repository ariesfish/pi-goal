import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  firstTextContent,
  resolveResearchToolContext,
  textToolResult,
} from "./tool-adapter.ts";
import { CheckGoalParams } from "../support/schema.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { checkResearchWorkspace } from "../workspace/research-workspace.ts";
import {
  formatGateSummary,
  gateJournalEntry,
  runGate,
} from "../execution/gate-runner.ts";
import { appendJournalEntry } from "../persistence/research-journal.ts";

export interface CheckGoalToolDeps {
  exec: Pick<ExtensionAPI, "exec">;
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  broadcastDashboardUpdate(workDir: string): void;
  readLastRun(workDir: string): Record<string, unknown> | null;
}

export function registerCheckGoalTool(pi: ExtensionAPI, deps: CheckGoalToolDeps): void {
  pi.registerTool({
    name: "check_goal",
    label: "Check Gate",
    description:
      "Run the frozen contract gate against the current workspace and metric, without logging a run. log_goal runs the same gate automatically on keep.",
    promptSnippet: "Run the goal gate before logging a keep",
    promptGuidelines: [
      "Use check_goal when you want the gate verdict before deciding to keep a run.",
      "Every blocking criterion must pass; test-file protection and scope checks are part of the gate.",
      "log_goal with status keep runs the same gate automatically, so a passing check_goal is not permission to skip it.",
    ],
    parameters: CheckGoalParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) return textToolResult(contextResult.text);
      const { runtime, workDir } = contextResult.context;
      const contract = runtime.state.contract;
      if (!contract) {
        return textToolResult("❌ No frozen contract. Call freeze_criteria before check_goal.");
      }

      const lastRun = deps.readLastRun(workDir);
      const lastMetric = typeof lastRun?.metric === "number" ? lastRun.metric : null;
      const metric = params.metric ?? lastMetric;
      if (metric === null) {
        return textToolResult("❌ No metric to check. Pass metric, or run and log a run first.");
      }

      const workspace = await checkResearchWorkspace(deps.exec, workDir);
      if (workspace.error) {
        return textToolResult(`❌ Gate could not read the workspace: ${workspace.error}`);
      }

      const gate = await runGate({
        pi: deps.exec,
        workDir,
        contract,
        state: runtime.state,
        metric,
        changedPaths: workspace.userPaths,
      });
      const journalError = appendJournalEntry(workDir, gateJournalEntry(gate));
      if (journalError) return textToolResult(journalError);

      deps.updateWidget(ctx);
      deps.broadcastDashboardUpdate(workDir);

      const lines = [
        formatGateSummary(gate),
        ...gate.criteria.map(
          (verdict) =>
            `- ${verdict.criterionId}${verdict.blocking ? "" : " (advisory)"}: ${verdict.pass ? "pass" : "fail"} — ${verdict.detail}`,
        ),
        gate.verdict === "pass"
          ? "log_goal keep will pass the same gate."
          : "Fix the failing criteria or log the attempt as discard with the failure in ASI.",
      ];
      return textToolResult(lines.join("\n"), { gate });
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("check_goal")), 0, 0);
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });
}
