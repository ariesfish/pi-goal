/**
 * A fake extension host: enough of ExtensionAPI and ExtensionContext to drive
 * tool registrations and event handlers without a pi session.
 */

import assert from "node:assert/strict";

import { createSessionRuntime } from "../../extensions/pi-goal/support/runtime.ts";

const loopOptions = {
  maxAutoResumeTurns: 20,
  maxActivationTurns: 3,
  benchmarkGuardrail: "Do not cheat.",
};

export { loopOptions };

/** Records registrations and lets a test fire an event handler by name. */
export function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  const userMessages = [];

  return {
    tools,
    commands,
    shortcuts,
    handlers,
    userMessages,
    registerTool(definition) {
      tools.set(definition.name, definition);
      return definition;
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
      return definition;
    },
    registerShortcut(key, definition) {
      shortcuts.set(key, definition);
    },
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    sendUserMessage(message) {
      userMessages.push(message);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    /** Invoke the single handler registered for an event. */
    async emit(event, payload, ctx) {
      const registered = handlers.get(event);
      assert.ok(registered, `no handler registered for ${event}`);
      assert.equal(registered.length, 1, `${event} has more than one handler`);
      return registered[0](payload, ctx);
    },
  };
}

/** Minimal stand-in for ExtensionContext. */
export function fakeCtx(cwd, options = {}) {
  const notices = [];
  return {
    notices,
    cwd,
    hasUI: options.hasUI ?? false,
    isIdle: () => options.idle ?? true,
    abort() {},
    ui: {
      notify(message, level) {
        notices.push({ message, level });
      },
      async confirm() {
        return true;
      },
      setWidget() {},
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getBranch: () => options.branch ?? [],
    },
  };
}

/** The host port a registration needs, with the view announcement recorded. */
export function fakePort(runtime = createSessionRuntime()) {
  const changes = [];
  return {
    runtime,
    changes,
    getRuntime: () => runtime,
    researchChanged(_ctx, workDir) {
      changes.push(workDir);
    },
    exec: {
      async exec() {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async fireHook() {
      return null;
    },
  };
}

export function runTool(tool, params, ctx) {
  return tool.execute("call-1", params, undefined, () => {}, ctx);
}

export function resultText(result) {
  return result.content[0].text;
}
