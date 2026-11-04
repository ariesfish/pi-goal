import type { GoalContract } from "../domain/goal-contract.ts";
import { matchGlob } from "../support/glob.ts";
import { bashWriteTargets } from "../support/shell-write-targets.ts";

export interface SealedGuardState {
  phase: string;
  contract: GoalContract | null;
  testEditsAllowed: boolean;
  benchmarkEditsAllowed: boolean;
}

export interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

const GIT_MUTATION = /\bgit\b[^\n;&|]*\b(reset|checkout|clean|commit|stash|revert)\b/;

export function sealedToolCallBlock(
  state: SealedGuardState,
  event: ToolCallLike,
): string | null {
  if (state.phase !== "sealed" || !state.contract) return null;

  if (event.toolName === "write" || event.toolName === "edit") {
    const filePath = typeof event.input.path === "string" ? event.input.path : null;
    if (!filePath) return null;
    return protectedWriteReason(filePath, state);
  }

  if (event.toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (GIT_MUTATION.test(command)) {
      return "Git mutations are managed by the extension. Use run_goal + log_goal; keep commits and reverts happen automatically.";
    }
    for (const target of bashWriteTargets(command)) {
      const reason = protectedWriteReason(target, state);
      if (reason) return reason;
    }
  }

  return null;
}

export function isProtectedTest(filePath: string, state: SealedGuardState): boolean {
  const contract = state.contract;
  if (!contract) return false;
  if (contract.allowTestEdits || state.testEditsAllowed) return false;
  return contract.testGlobs.some((glob) => matchGlob(filePath, glob));
}

function protectedWriteReason(filePath: string, state: SealedGuardState): string | null {
  if (isExtensionState(filePath)) {
    return "This path is extension-managed research state. The journal, attempts, contract, and active pointer are written by the extension, not edited directly.";
  }
  if (!state.benchmarkEditsAllowed && isBenchmarkFile(filePath)) {
    return "goal.sh and goal.checks.sh are protected in the sealed phase. Ask the human to run /goal allow-benchmark if the benchmark itself must change.";
  }
  if (isProtectedTest(filePath, state)) {
    return "Test files are protected in the sealed phase. Change the code, or ask the human to run /goal allow-tests for this research.";
  }
  return null;
}

function isExtensionState(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.endsWith("goal.jsonl") ||
    normalized.endsWith("goal.config.json") ||
    normalized.endsWith("/active") ||
    normalized.includes("/.goal/active") ||
    normalized.startsWith(".goal/active") ||
    normalized.includes("/attempts/") ||
    normalized.includes("/.goal/attempts/")
  );
}

function isBenchmarkFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized === "goal.sh" ||
    normalized.endsWith("/goal.sh") ||
    normalized === "goal.checks.sh" ||
    normalized.endsWith("/goal.checks.sh")
  );
}
