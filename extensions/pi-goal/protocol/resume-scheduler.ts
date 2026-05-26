import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ResearchProtocolOptions } from "./research-phase.ts";
import {
  cancelResearchResume,
  decidePendingResearchResume,
  hasPendingResearchResume,
  onResearchResumeDelivered,
  shouldNotifyResearchResumeLimit,
} from "./research-protocol.ts";
import type { SessionRuntime } from "../support/runtime.ts";

export interface ResumeAdapter {
  pause(runtime: SessionRuntime): void;
  cancel(runtime: SessionRuntime): void;
  ensure(
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    gate: (runtime: SessionRuntime) => boolean,
    composeMessage?: (ctx: ExtensionContext) => string,
  ): void;
  sendWhenReady(ctx: ExtensionContext, message: string): void;
}

export function createResumeAdapter(options: {
  pi: ExtensionAPI;
  loopOptions: ResearchProtocolOptions;
  settledWindowMs: number;
  notifyAutoResumeLimitReached(ctx: ExtensionContext): void;
  composeResearchPhaseResumeMessage(ctx: ExtensionContext): string;
}): ResumeAdapter {
  const isAgentSettled = (ctx: ExtensionContext): boolean =>
    ctx.isIdle() && !ctx.hasPendingMessages();

  const pause = (runtime: SessionRuntime): void => {
    if (!runtime.pendingResumeTimer) return;
    clearTimeout(runtime.pendingResumeTimer);
    runtime.pendingResumeTimer = null;
  };

  const cancel = (runtime: SessionRuntime): void => {
    pause(runtime);
    cancelResearchResume(runtime);
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, runtime: SessionRuntime): void => {
    const decision = decidePendingResearchResume(runtime, options.loopOptions, isAgentSettled(ctx));
    if (decision.action === "wait") return;
    if (decision.action === "cancel") {
      cancel(runtime);
      return;
    }
    if (decision.action === "limit_reached") {
      cancel(runtime);
      options.notifyAutoResumeLimitReached(ctx);
      return;
    }

    onResearchResumeDelivered(runtime);
    pause(runtime);
    options.pi.sendUserMessage(decision.message);
  };

  const schedule = (ctx: ExtensionContext, runtime: SessionRuntime, message: string): void => {
    pause(runtime);
    runtime.loop.pendingResumeMessage = message;
    runtime.pendingResumeTimer = setTimeout(
      () => sendPendingResumeIfReady(ctx, runtime),
      options.settledWindowMs,
    );
  };

  const reschedule = (ctx: ExtensionContext, runtime: SessionRuntime): void => {
    if (!hasPendingResearchResume(runtime)) return;
    schedule(ctx, runtime, runtime.loop.pendingResumeMessage!);
  };

  const ensure = (
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    gate: (runtime: SessionRuntime) => boolean,
    composeMessage: (ctx: ExtensionContext) => string = options.composeResearchPhaseResumeMessage,
  ): void => {
    if (hasPendingResearchResume(runtime)) {
      reschedule(ctx, runtime);
      return;
    }
    if (!gate(runtime)) return;
    if (shouldNotifyResearchResumeLimit(runtime, options.loopOptions)) {
      options.notifyAutoResumeLimitReached(ctx);
      return;
    }
    schedule(ctx, runtime, composeMessage(ctx));
  };

  const sendWhenReady = (ctx: ExtensionContext, message: string): void => {
    if (ctx.isIdle()) {
      options.pi.sendUserMessage(message);
      return;
    }
    options.pi.sendUserMessage(message, { deliverAs: "followUp" });
  };

  return { pause, cancel, ensure, sendWhenReady };
}
