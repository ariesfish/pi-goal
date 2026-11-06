import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  firstTextContent,
  resolveResearchToolContext,
  textToolResult,
  type ResearchToolPort,
} from "./tool-adapter.ts";
import { ReviewGoalParams } from "../support/schema.ts";
import { readReviewerConfig } from "../persistence/goal-config.ts";
import { recordReview } from "../workflows/review-workflow.ts";

export function registerReviewGoalTool(pi: ExtensionAPI, deps: ResearchToolPort): void {
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
      const { runtime, workDir, ctxCwd } = contextResult.context;
      const contract = runtime.state.contract;
      if (!contract) {
        return textToolResult("❌ No frozen contract. Call freeze_criteria before review_goal.");
      }
      const reviewer = readReviewerConfig(ctxCwd ?? workDir);
      if (!reviewer) {
        return textToolResult(
          "❌ No reviewer configured. Add reviewer.model (pi subagent) or reviewer.command (external command) to goal.config.json.",
        );
      }

      try {
        const recording = await recordReview({
          pi: deps.exec,
          workDir,
          contract,
          state: runtime.state,
          reviewer,
        });
        if (!recording.recorded) return textToolResult(recording.text);

        deps.researchChanged(ctx, workDir);
        return textToolResult(recording.result.text, { review: recording.result.review });
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
