import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  firstTextContent,
  resolveResearchToolContext,
  textToolResult,
} from "./tool-adapter.ts";
import { ReviewGoalParams } from "../support/schema.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { checkResearchWorkspace } from "../workspace/research-workspace.ts";
import { readReviewerConfig } from "../persistence/goal-config.ts";
import { appendJournalEntry } from "../persistence/research-journal.ts";
import { runReview } from "../workflows/review-workflow.ts";

export interface ReviewGoalToolDeps {
  exec: Pick<ExtensionAPI, "exec">;
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  updateWidget(ctx: ExtensionContext): void;
  broadcastDashboardUpdate(workDir: string): void;
}

export function registerReviewGoalTool(pi: ExtensionAPI, deps: ReviewGoalToolDeps): void {
  pi.registerTool({
    name: "review_goal",
    label: "Review Goal",
    description:
      "Run the configured blind reviewer over the current diff, frozen criteria, and gate output. Each finding's repro is executed; only reproduced findings can block.",
    promptSnippet: "Run the blind reviewer and verify its findings",
    promptGuidelines: [
      "review_goal is optional; configure reviewer.command in goal.config.json first.",
      "The reviewer sees the diff, criteria, and gate output, never your summary.",
      "A finding without a repro, or whose repro passes, is advisory and does not block.",
    ],
    parameters: ReviewGoalParams,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const contextResult = resolveResearchToolContext(ctx, deps.getRuntime);
      if (!contextResult.ok) return textToolResult(contextResult.text);
      const { runtime, workDir } = contextResult.context;
      const contract = runtime.state.contract;
      if (!contract) {
        return textToolResult("❌ No frozen contract. Call freeze_criteria before review_goal.");
      }
      const reviewer = readReviewerConfig(workDir);
      if (!reviewer) {
        return textToolResult(
          "❌ No reviewer configured. Add reviewer.command (and optional args/timeoutSeconds/blocking) to goal.config.json.",
        );
      }

      const workspace = await checkResearchWorkspace(deps.exec, workDir);
      if (workspace.error) {
        return textToolResult(`❌ Reviewer could not read the workspace: ${workspace.error}`);
      }

      try {
        const review = await runReview({
          pi: deps.exec,
          workDir,
          contract,
          state: runtime.state,
          reviewer,
          changedPaths: workspace.userPaths,
        });
        const journalError = appendJournalEntry(workDir, {
          type: "review",
          review: review.review,
        });
        if (journalError) return textToolResult(journalError);

        deps.updateWidget(ctx);
        deps.broadcastDashboardUpdate(workDir);
        return textToolResult(review.text, { review: review.review });
      } catch (error) {
        return textToolResult(
          `❌ Reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("review_goal")), 0, 0);
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });
}
