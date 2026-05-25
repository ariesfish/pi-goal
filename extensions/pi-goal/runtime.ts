import { createResearchState, type RunResult, type ResearchState } from "./research-state.ts";
import { createLoopControllerState, type LoopControllerState } from "./loop-controller.ts";

export interface LogDetails {
  runResult: RunResult;
  state: ResearchState;
  wallClockSeconds: number | null;
}

export interface SessionRuntime {
  loop: LoopControllerState;
  dashboardExpanded: boolean;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  activeRun: { startedAt: number; command: string } | null;
  state: ResearchState;
  /** Pending auto-resume timer; cancelled when the agent starts a new run or compacts. */
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
}

export function createSessionRuntime(): SessionRuntime {
  return {
    loop: createLoopControllerState(),
    dashboardExpanded: false,
    lastRunChecks: null,
    lastRunDuration: null,
    activeRun: null,
    state: createResearchState(),
    pendingResumeTimer: null,
  };
}

export function createRuntimeStore() {
  const runtimes = new Map<string, SessionRuntime>();

  return {
    ensure(sessionKey: string): SessionRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}
