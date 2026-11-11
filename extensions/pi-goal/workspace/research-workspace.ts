import * as fs from "node:fs";
import * as path from "node:path";

import { isResearchStatePath } from "../persistence/research-directory.ts";
import type { Attempt } from "../domain/goal-contract.ts";
import type { HostExec } from "../support/exec.ts";


export interface ResearchWorkspaceCheck {
  clean: boolean;
  paths: string[];
  userPaths: string[];
  researchPaths: string[];
  error: string | null;
}

export interface CommitKeptRunResultOptions {
  pi: HostExec;
  workDir: string;
  description: string;
  metricName: string;
  metric: number;
  status: string;
  secondaryMetrics: Record<string, number>;
  criteriaIds?: string[];
  gateHash?: string;
}

export interface CommitKeptRunResult {
  ok: boolean;
  text: string;
  commit: string | null;
}

export async function checkResearchWorkspace(
  pi: HostExec,
  cwd: string,
): Promise<ResearchWorkspaceCheck> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 5000 });
    if (result.code !== 0) {
      return {
        clean: false,
        paths: [],
        userPaths: [],
        researchPaths: [],
        error: `git status failed (exit ${result.code}): ${(result.stdout + result.stderr).trim()}`,
      };
    }

    const paths = parsePorcelainPaths(result.stdout);
    const researchPaths = paths.filter(isResearchStatePath);
    const userPaths = paths.filter((filePath) => !isResearchStatePath(filePath));
    return {
      clean: paths.length === 0,
      paths,
      userPaths,
      researchPaths,
      error: null,
    };
  } catch (error) {
    return {
      clean: false,
      paths: [],
      userPaths: [],
      researchPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatWorkspaceSafetyError(check: ResearchWorkspaceCheck): string {
  if (check.error) return `Git workspace safety check failed: ${check.error}`;
  if (check.userPaths.length === 0) return "";
  return [
    "Git workspace has pre-existing non-research changes.",
    "Research uses automatic commit/revert, so start from a clean tree or commit/stash these files first:",
    ...check.userPaths.slice(0, 20).map((filePath) => `- ${filePath}`),
    check.userPaths.length > 20 ? `... and ${check.userPaths.length - 20} more` : "",
  ].filter(Boolean).join("\n");
}

export async function commitKeptRunResult(
  options: CommitKeptRunResultOptions,
): Promise<CommitKeptRunResult> {
  let text = "";
  let commit: string | null = null;
  let ok = true;

  try {
    const resultData: Record<string, unknown> = {
      status: options.status,
      [options.metricName || "metric"]: options.metric,
      ...options.secondaryMetrics,
    };
    const trailerJson = JSON.stringify(resultData);
    const trailers = [`Result: ${trailerJson}`];
    if (options.gateHash) trailers.push(`Gate: ${options.gateHash}`);
    if (options.criteriaIds && options.criteriaIds.length > 0) {
      trailers.push(`Criteria: ${options.criteriaIds.join(",")}`);
    }
    const commitMsg = `${options.description}\n\n${trailers.join("\n")}`;

    const execOpts = { cwd: options.workDir, timeout: 10000 };
    const addResult = await options.pi.exec(
      "git",
      ["add", "-A", "--", ".", ":(exclude,glob)**/.goal", ":(exclude,glob)**/.goal/**"],
      execOpts,
    );
    if (addResult.code !== 0) {
      const addErr = (addResult.stdout + addResult.stderr).trim();
      throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
    }

    const diffResult = await options.pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
    if (diffResult.code === 0) {
      text += `\n📝 Git: nothing to commit (working tree clean)`;
    } else {
      const gitResult = await options.pi.exec("git", ["commit", "-m", commitMsg], execOpts);
      const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
      if (gitResult.code === 0) {
        const firstLine = gitOutput.split("\n")[0] || "";
        text += `\n📝 Git: committed — ${firstLine}`;

        try {
          const shaResult = await options.pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: options.workDir, timeout: 5000 });
          const newSha = (shaResult.stdout || "").trim();
          if (newSha && newSha.length >= 7) {
            commit = newSha;
          }
        } catch {
          // Keep caller-provided commit hash if rev-parse fails.
        }
      } else {
        ok = false;
        text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
      }
    }
  } catch (e) {
    ok = false;
    text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return { ok, text, commit };
}

export interface RestoreRejectedRunResult {
  text: string;
  attempt: Attempt | null;
}

export async function restoreRejectedRunResult(options: {
  pi: HostExec;
  workDir: string;
  status: "discard" | "crash" | "checks_failed";
  runNumber: number;
  description: string;
  attemptsDir: string;
}): Promise<RestoreRejectedRunResult> {
  const checkpoint = await readCheckpoint(options.pi, options.workDir);
  const patchPath = path.join(options.attemptsDir, `${options.runNumber}.patch`);
  try {
    fs.mkdirSync(options.attemptsDir, { recursive: true });
    const revertScript = `
            git add -A -- . ':(exclude,glob)**/.goal/**' ':(exclude,glob)**/goal.*' ':(exclude,glob)**/goal.hooks/**' 2>/dev/null || true
            git diff --cached --binary > ${shellQuote(patchPath)}
            git reset --hard HEAD
            git clean -fd -e '.goal' -e '**/.goal/**' -e 'goal.*' -e '**/goal.*/**' -e 'goal.hooks' -e '**/goal.hooks/**' 2>/dev/null || true
          `;
    const result = await options.pi.exec("bash", ["-c", revertScript], { cwd: options.workDir, timeout: 15000 });
    if (result.code !== 0) {
      throw new Error((result.stdout + result.stderr).trim().slice(0, 300) || `exit ${result.code}`);
    }
    const attempt: Attempt = {
      run: options.runNumber,
      status: options.status,
      checkpoint,
      patchPath,
      description: options.description,
      at: Date.now(),
    };
    return {
      text: `\n📝 Git: reverted changes (${options.status}) to ${checkpoint.slice(0, 7)} — attempt diff kept at ${patchPath}`,
      attempt: fs.existsSync(patchPath) ? attempt : null,
    };
  } catch (e) {
    return {
      text: `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`,
      attempt: null,
    };
  }
}

export async function readCheckpoint(
  pi: HostExec,
  workDir: string,
): Promise<string> {
  try {
    const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: workDir, timeout: 5000 });
    return (result.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    if (!raw) continue;
    const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
    paths.push(unquotePath(renamed));
  }
  return paths.map((filePath) => path.normalize(filePath));
}

function unquotePath(filePath: string): string {
  if (!filePath.startsWith('"') || !filePath.endsWith('"')) return filePath;
  try {
    return JSON.parse(filePath);
  } catch {
    return filePath.slice(1, -1);
  }
}
