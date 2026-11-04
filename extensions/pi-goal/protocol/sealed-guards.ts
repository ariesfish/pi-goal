import type { GoalContract } from "../domain/goal-contract.ts";
import { matchGlob } from "../execution/gate-runner.ts";

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
const DEV_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "&1", "&2"]);

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

/**
 * Best-effort target extraction for shell writes. It covers redirection,
 * tee, in-place sed/perl, copy/move, dd of=, and truncate. Arbitrary
 * interpreters (python -c, node -e, compiled helpers) remain a residual
 * bypass; the guard is a speed bump, not a sandbox.
 */
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim().replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
    if (!trimmed || trimmed.startsWith("-") || DEV_SINKS.has(trimmed)) return;
    if (!targets.includes(trimmed)) targets.push(trimmed);
  };

  for (const match of command.matchAll(/(?:^|[^0-9&])(?:>>?|1>>?|2>>?|&>)\s*([^\s;&|<>()]+)/g)) {
    add(match[1]);
  }

  for (const match of command.matchAll(/\btee\b((?:\s+-{1,2}[\w-]+)*)\s+([^;&|]+)/g)) {
    for (const token of match[2].split(/\s+/)) add(token);
  }

  for (const match of command.matchAll(/\b(?:sed|perl)\b([^;&|]*)/g)) {
    if (!/\s-[a-zA-Z]*i/.test(match[1]) && !/\s--in-place\b/.test(match[1])) continue;
    for (const token of match[1].split(/\s+/)) {
      if (token.startsWith("-") || /^s[/|#]/.test(token) || token === "") continue;
      add(token);
    }
  }

  for (const match of command.matchAll(/\b(?:cp|mv|install)\b([^;&|]*)/g)) {
    const tokens = match[1].split(/\s+/).filter((token) => token && !token.startsWith("-"));
    if (tokens.length >= 2) add(tokens[tokens.length - 1]);
  }

  for (const match of command.matchAll(/\bdd\b[^;&|]*\bof=([^\s;&|]+)/g)) {
    add(match[1]);
  }

  for (const match of command.matchAll(/\btruncate\b([^;&|]*)/g)) {
    const tokens = match[1].split(/\s+/).filter((token) => token && !token.startsWith("-"));
    if (tokens.length >= 2) add(tokens[tokens.length - 1]);
  }

  return targets;
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
