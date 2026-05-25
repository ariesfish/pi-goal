import * as path from "node:path";

import { isResearchStatePath } from "../persistence/research-paths.ts";

export interface WorkspaceExecAdapter {
  exec(command: string, args: string[], options: { cwd?: string; timeout?: number }): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
}

export interface ResearchWorkspaceCheck {
  clean: boolean;
  paths: string[];
  userPaths: string[];
  researchPaths: string[];
  error: string | null;
}

export interface CommitKeptRunResultOptions {
  pi: WorkspaceExecAdapter;
  workDir: string;
  description: string;
  metricName: string;
  metric: number;
  status: string;
  secondaryMetrics: Record<string, number>;
}

export interface CommitKeptRunResult {
  text: string;
  commit: string | null;
}

export async function checkResearchWorkspace(
  pi: WorkspaceExecAdapter,
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

  try {
    const resultData: Record<string, unknown> = {
      status: options.status,
      [options.metricName || "metric"]: options.metric,
      ...options.secondaryMetrics,
    };
    const trailerJson = JSON.stringify(resultData);
    const commitMsg = `${options.description}\n\nResult: ${trailerJson}`;

    const execOpts = { cwd: options.workDir, timeout: 10000 };
    const addResult = await options.pi.exec("git", ["add", "-A"], execOpts);
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
        text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
      }
    }
  } catch (e) {
    text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return { text, commit };
}

export async function restoreRejectedRunResult(options: {
  pi: WorkspaceExecAdapter;
  workDir: string;
  status: string;
}): Promise<string> {
  try {
    const revertScript = `
            git checkout -- . ':(exclude,glob)**/.goal/**' ':(exclude,glob)**/goal.*' ':(exclude,glob)**/goal.*/**'
            git clean -fd -e '.goal' -e '.goal/**' -e 'goal.*' -e '**/goal.*/**' 2>/dev/null
          `;
    await options.pi.exec("bash", ["-c", revertScript], { cwd: options.workDir, timeout: 10000 });
    return `\n📝 Git: reverted changes (${options.status}) — goal files preserved`;
  } catch (e) {
    return `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
  }
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
