import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { HookPayload } from "../execution/hooks.ts";
import { resolveWorkDir, validateWorkDir } from "../persistence/goal-config.ts";
import type { SessionRuntime } from "../support/runtime.ts";

/**
 * What a tool needs from the extension host. One port rather than a per-tool
 * callback bag: adding a host capability touches this type and the composition
 * root, not eight dep interfaces.
 */
export interface ResearchToolPort {
  getRuntime(ctx: ExtensionContext): SessionRuntime;
  /** Announce one change to every view that mirrors research state. */
  researchChanged(ctx: ExtensionContext, workDir: string): void;
  exec: Pick<ExtensionAPI, "exec">;
  fireHook(payload: HookPayload): Promise<string | null>;
}

export interface ResearchToolContext {
  runtime: SessionRuntime;
  workDir: string;
  ctxCwd: string;
}

export type ResearchWorkDirResult =
  | { ok: true; workDir: string; ctxCwd: string }
  | { ok: false; text: string };

export type ResearchToolContextResult =
  | { ok: true; context: ResearchToolContext }
  | { ok: false; text: string };

export function resolveResearchWorkDir(ctx: ExtensionContext): ResearchWorkDirResult {
  const workDirError = validateWorkDir(ctx.cwd);
  if (workDirError) return { ok: false, text: `❌ ${workDirError}` };
  return { ok: true, workDir: resolveWorkDir(ctx.cwd), ctxCwd: ctx.cwd };
}

export function resolveResearchToolContext(
  ctx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => SessionRuntime,
): ResearchToolContextResult {
  const workDirResult = resolveResearchWorkDir(ctx);
  if (!workDirResult.ok) return workDirResult;

  return {
    ok: true,
    context: {
      runtime: getRuntime(ctx),
      workDir: workDirResult.workDir,
      ctxCwd: workDirResult.ctxCwd,
    },
  };
}

export function textToolResult(text: string, details: object = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function firstTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  return item?.type === "text" ? item.text ?? "" : "";
}
