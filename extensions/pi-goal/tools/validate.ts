import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { validateWorkDir, resolveWorkDir } from "../persistence/goal-config.ts";
import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../workspace/research-workspace.ts";
import { ValidateResearchParams } from "../support/schema.ts";
import {
  formatResearchValidationResult,
  validateResearch,
} from "../research-validation-workflow.ts";

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
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
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
      return {
        content: [{ type: "text", text: formatResearchValidationResult(result) }],
        details: result,
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("validate_goal")), 0, 0);
    },

    renderResult(result, _options, _theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });
}
