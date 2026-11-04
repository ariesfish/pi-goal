import type { GoalContract } from "../domain/goal-contract.ts";
import { matchGlob } from "../execution/gate-runner.ts";

export interface SealedGuardState {
  phase: string;
  contract: GoalContract | null;
  testEditsAllowed: boolean;
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
    if (isExtensionState(filePath)) {
      return "This path is extension-managed research state. The journal and frozen contract are written by the extension, not edited directly.";
    }
    if (isProtectedTest(filePath, state)) {
      return "Test files are protected in the sealed phase. Change the code, or ask the human to run /goal allow-tests for this research.";
    }
  }

  if (event.toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (GIT_MUTATION.test(command)) {
      return "Git mutations are managed by the extension. Use run_goal + log_goal; keep commits and reverts happen automatically.";
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

function isExtensionState(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/.goal/") ||
    normalized.startsWith(".goal/") ||
    normalized.endsWith("goal.jsonl") ||
    normalized.endsWith("goal.config.json")
  );
}
