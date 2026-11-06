import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  composeResearchResumeMessage,
  composeResearchSystemPrompt,
  syncResearchPhaseForTurn,
} from "../protocol/research-protocol.ts";
import {
  markResearchAutoResumeSent,
  resetResearchPhaseForAgentStart,
  type ResearchProtocolOptions,
} from "../protocol/research-phase.ts";
import { decideBoundaryContinuation } from "../protocol/boundary-resume.ts";
import { sealedToolCallBlock } from "../protocol/sealed-guards.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import { resolveWorkDir } from "../persistence/goal-config.ts";
import {
  buildResearchCompactionSummary,
  researchSummaryPathsFor,
} from "../support/compaction.ts";
import type { GoalShortcuts } from "../support/shortcuts.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import type { ResearchToolPort } from "./tool-adapter.ts";

/**
 * What the pi session lifecycle needs from the extension: the research runtime,
 * the views that mirror it, and the state rebuild hook.
 */
export interface SessionHandlerDeps {
  port: ResearchToolPort;
  loopOptions: ResearchProtocolOptions;
  shortcuts: GoalShortcuts;
  /** Rebuild a session's runtime from the journal (or the session branch). */
  reconstruct(ctx: ExtensionContext): void;
  clearSessionUi(ctx: ExtensionContext): void;
  clearOverlay(): void;
  requestOverlayRender(): void;
  openDashboard(ctx: ExtensionContext, runtime: SessionRuntime): Promise<void>;
  stopDashboard(): void;
  clearRuntime(ctx: ExtensionContext): void;
}

/** The pi session lifecycle: load, guard, steer, compact, shut down. */
export function registerSessionHandlers(pi: ExtensionAPI, deps: SessionHandlerDeps): void {
  const { port, loopOptions } = deps;

  pi.on("session_start", async (_e, ctx) => deps.reconstruct(ctx));
  pi.on("session_tree", async (_e, ctx) => deps.reconstruct(ctx));
  pi.on("session_before_switch", async () => deps.clearOverlay());

  pi.on("session_before_compact", async (event, ctx) => {
    const runtime = port.getRuntime(ctx);
    if (!runtime.loop.mode) return;
    return {
      compaction: {
        summary: buildResearchCompactionSummary(
          researchSummaryPathsFor(resolveWorkDir(ctx.cwd)),
          runtime.loop.phase,
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    deps.clearSessionUi(ctx);
    deps.clearRuntime(ctx);
    deps.stopDashboard();
  });

  pi.on("agent_start", async (_event, ctx) => {
    const runtime = port.getRuntime(ctx);
    resetResearchPhaseForAgentStart(runtime.loop);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const runtime = port.getRuntime(ctx);
    runtime.activeRun = null;
    deps.requestOverlayRender();
  });

  // Sealed phase: the extension owns test edits, git mutations, and research state.
  pi.on("tool_call", async (event, ctx) => {
    const runtime = port.getRuntime(ctx);
    const reason = sealedToolCallBlock(
      {
        phase: runtime.loop.phase,
        contract: runtime.state.contract,
        testEditsAllowed: runtime.state.testEditsAllowed,
        benchmarkEditsAllowed: runtime.state.benchmarkEditsAllowed,
      },
      { toolName: event.toolName, input: event.input as Record<string, unknown> },
    );
    if (!reason) return;
    return { block: true, reason };
  });

  // Final actionable boundary: request one continuation instead of racing a timer.
  pi.on("agent_before_settle", async (event, ctx) => {
    const runtime = port.getRuntime(ctx);
    const decision = decideBoundaryContinuation({
      runtime,
      options: loopOptions,
      canContinue: event.context.canContinue,
      outcome: event.outcome,
      composeMessage: () => composeResearchResumeMessage(runtime, loopOptions),
    });

    if (decision.action === "stop") {
      ctx.ui.notify(decision.reason, "info");
      return;
    }
    if (decision.action !== "continue") return;

    markResearchAutoResumeSent(runtime.loop);
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: "goal-next-action",
          content: decision.message,
          display: false,
        },
      ],
      continue: true,
    };
  });

  // When in goal mode, add phase-specific loop control to the system prompt.
  // Only paths and required actions — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = port.getRuntime(ctx);
    const workDir = resolveWorkDir(ctx.cwd);
    const fileContract = readResearchFileContract(workDir);
    syncResearchPhaseForTurn(runtime.loop, fileContract);
    const extra = composeResearchSystemPrompt(runtime.loop, fileContract, loopOptions);

    if (!extra) return;
    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });
}

/** Dashboard shortcuts: expand/collapse the widget, open the fullscreen overlay. */
export function registerDashboardShortcuts(pi: ExtensionAPI, deps: SessionHandlerDeps): void {
  const { port, shortcuts } = deps;

  if (shortcuts.toggleDashboard) {
    pi.registerShortcut(shortcuts.toggleDashboard as any, {
      description: "Toggle goal dashboard",
      handler: async (ctx: ExtensionContext) => {
        const runtime = port.getRuntime(ctx);
        if (runtime.state.results.length === 0 && !runtime.loop.mode) {
          ctx.ui.notify("No runs yet — run /goal to get started", "info");
          return;
        }
        runtime.dashboardExpanded = !runtime.dashboardExpanded;
        deps.requestOverlayRender();
        port.researchChanged(ctx, resolveWorkDir(ctx.cwd));
      },
    });
  }

  if (shortcuts.fullscreenDashboard) {
    pi.registerShortcut(shortcuts.fullscreenDashboard as any, {
      description: "Fullscreen goal dashboard",
      handler: async (ctx: ExtensionContext) => {
        const runtime = port.getRuntime(ctx);
        if (runtime.state.results.length === 0 && !runtime.loop.mode) {
          ctx.ui.notify("No runs yet", "info");
          return;
        }
        await deps.openDashboard(ctx, runtime);
      },
    });
  }
}
