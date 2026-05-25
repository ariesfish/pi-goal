import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  cancelPendingResume as cancelControllerPendingResume,
  hasPendingResume as controllerHasPendingResume,
  hasReachedAutoResumeLimit as controllerHasReachedAutoResumeLimit,
  markAutoResumeSent as markControllerAutoResumeSent,
  type LoopControllerOptions,
} from "./loop-controller.ts";
import type { SessionRuntime } from "./runtime.ts";

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
  loopOptions: LoopControllerOptions;
  settledWindowMs: number;
  notifyAutoResumeLimitReached(ctx: ExtensionContext): void;
  composeResumeMessage(ctx: ExtensionContext): string;
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
    cancelControllerPendingResume(runtime.loop);
  };

  const sendPendingResumeIfReady = (ctx: ExtensionContext, runtime: SessionRuntime): void => {
    const message = runtime.loop.pendingResumeMessage;

    if (!message) return;
    if (!runtime.loop.mode) {
      cancel(runtime);
      return;
    }
    if (!isAgentSettled(ctx)) return;
    if (controllerHasReachedAutoResumeLimit(runtime.loop, options.loopOptions)) {
      cancel(runtime);
      options.notifyAutoResumeLimitReached(ctx);
      return;
    }

    cancel(runtime);
    markControllerAutoResumeSent(runtime.loop);
    options.pi.sendUserMessage(message);
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
    if (!controllerHasPendingResume(runtime.loop)) return;
    schedule(ctx, runtime, runtime.loop.pendingResumeMessage!);
  };

  const ensure = (
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    gate: (runtime: SessionRuntime) => boolean,
    composeMessage: (ctx: ExtensionContext) => string = options.composeResumeMessage,
  ): void => {
    if (controllerHasPendingResume(runtime.loop)) {
      reschedule(ctx, runtime);
      return;
    }
    if (!gate(runtime)) return;
    if (controllerHasReachedAutoResumeLimit(runtime.loop, options.loopOptions)) {
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
