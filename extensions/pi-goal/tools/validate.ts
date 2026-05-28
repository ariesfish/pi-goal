import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  firstTextContent,
  resolveResearchWorkDir,
  textToolResult,
} from "./tool-adapter.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../workspace/research-workspace.ts";
import { ValidateResearchParams } from "../support/schema.ts";
import {
  formatResearchValidationResult,
  validateResearch,
} from "../workflows/research-workflow.ts";

export function registerValidateResearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "validate_goal",
    label: "Validate Research",
    description:
      "Validate the active research files: goal.md, goal.sh, goal.jsonl config, primary METRIC output, checks file, workingDir, and git workspace safety.",
    promptSnippet:
      "Validate active research files and primary metric contract before running goal",
    promptGuidelines: [
      "Use validate_goal when active research setup is uncertain, after creating research files, and before the baseline run.",
      "If validation reports missing config, call init_goal. If it reports missing primary metric, fix goal.sh or call start_goal with the correct metric name.",
    ],
    parameters: ValidateResearchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDirResult = resolveResearchWorkDir(ctx);
      if (!workDirResult.ok) return textToolResult(workDirResult.text);
      const workDir = workDirResult.workDir;
      const dirtyCheck = await checkResearchWorkspace(pi, workDir);
      const dirtyBlock = formatWorkspaceSafetyError(dirtyCheck);
      const result = await validateResearch({
        workDir,
        pi,
        dryRun: params.dry_run ?? true,
        timeoutMs: (params.timeout_seconds ?? 60) * 1000,
      });
      if (dirtyBlock) {
        result.issues.push({ code: "dirty_tree", severity: "error", message: dirtyBlock });
        result.ok = false;
      }
      return textToolResult(formatResearchValidationResult(result), result);
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("validate_goal")), 0, 0);
    },

    renderResult(result, _options, _theme) {
      return new Text(firstTextContent(result), 0, 0);
    },
  });
}
