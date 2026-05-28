import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import type { SessionRuntime } from "../support/runtime.ts";

export interface ResearchToolContext {
  runtime: SessionRuntime;
  workDir: string;
  ctxCwd: string;
}

export type ResearchToolContextResult =
  | { ok: true; context: ResearchToolContext }
  | { ok: false; text: string };

export function resolveResearchToolContext(
  ctx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => SessionRuntime,
): ResearchToolContextResult {
  const workDirError = validateWorkDir(ctx.cwd);
  if (workDirError) return { ok: false, text: `❌ ${workDirError}` };

  return {
    ok: true,
    context: {
      runtime: getRuntime(ctx),
      workDir: resolveWorkDir(ctx.cwd),
      ctxCwd: ctx.cwd,
    },
  };
}

export function textToolResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function firstTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  return item?.type === "text" ? item.text ?? "" : "";
}
