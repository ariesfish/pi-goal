import * as fs from "node:fs";
import * as path from "node:path";

import { researchConfigPath } from "./research-directory.ts";

export interface ReviewerConfig {
  kind?: "pi" | "command";
  command?: string;
  args?: string[];
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  blocking?: boolean;
}

export interface ResearchConfig {
  maxIterations?: number;
  workingDir?: string;
  reviewer?: ReviewerConfig;
}

export type ConfigResult =
  | { ok: true; config: ResearchConfig; error: null }
  | { ok: false; config: ResearchConfig; error: string };

export function readConfig(cwd: string): ConfigResult {
  const configPath = researchConfigPath(cwd);
  if (!fs.existsSync(configPath)) return { ok: true, config: {}, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    return {
      ok: false,
      config: {},
      error: `Could not parse goal.config.json at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      config: {},
      error: `Invalid goal.config.json at ${configPath}: expected a JSON object.`,
    };
  }

  const config: ResearchConfig = {};
  if (parsed.maxIterations !== undefined) {
    if (typeof parsed.maxIterations !== "number" || !Number.isFinite(parsed.maxIterations) || parsed.maxIterations <= 0) {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: maxIterations must be a positive number.`,
      };
    }
    config.maxIterations = parsed.maxIterations;
  }

  if (parsed.workingDir !== undefined) {
    if (typeof parsed.workingDir !== "string" || parsed.workingDir.trim() === "") {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: workingDir must be a non-empty string.`,
      };
    }
    config.workingDir = parsed.workingDir;
  }

  if (parsed.reviewer !== undefined) {
    const reviewer = parsed.reviewer;
    if (!isRecord(reviewer)) {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: reviewer must be an object.`,
      };
    }

    const kind = reviewer.kind === "command" ? "command" : reviewer.kind === "pi" ? "pi" : reviewer.model ? "pi" : "command";
    if (kind === "pi") {
      if (typeof reviewer.model !== "string" || reviewer.model.trim() === "") {
        return {
          ok: false,
          config: {},
          error: `Invalid goal.config.json at ${configPath}: reviewer.model is required for kind "pi".`,
        };
      }
    } else if (typeof reviewer.command !== "string" || reviewer.command.trim() === "") {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: reviewer.command must be a non-empty string.`,
      };
    }

    if (reviewer.args !== undefined && (!Array.isArray(reviewer.args) || !reviewer.args.every((arg) => typeof arg === "string"))) {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: reviewer.args must be an array of strings.`,
      };
    }
    if (reviewer.timeoutSeconds !== undefined && (typeof reviewer.timeoutSeconds !== "number" || reviewer.timeoutSeconds <= 0)) {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: reviewer.timeoutSeconds must be a positive number.`,
      };
    }
    if (reviewer.thinking !== undefined && typeof reviewer.thinking !== "string") {
      return {
        ok: false,
        config: {},
        error: `Invalid goal.config.json at ${configPath}: reviewer.thinking must be a string.`,
      };
    }

    config.reviewer = {
      kind,
      command: typeof reviewer.command === "string" ? reviewer.command : undefined,
      args: reviewer.args,
      model: typeof reviewer.model === "string" ? reviewer.model : undefined,
      thinking: reviewer.thinking,
      timeoutSeconds: reviewer.timeoutSeconds,
      blocking: reviewer.blocking === true,
    };
  }

  return { ok: true, config, error: null };
}

export function readReviewerConfig(cwd: string): ReviewerConfig | null {
  const result = readConfig(cwd);
  if (!result.ok || !result.config.reviewer) return null;
  return result.config.reviewer;
}

export function readRunLimit(cwd: string): number | null {
  const result = readConfig(cwd);
  if (!result.ok) return null;
  return typeof result.config.maxIterations === "number"
    ? Math.floor(result.config.maxIterations)
    : null;
}

export function resolveWorkDir(ctxCwd: string): string {
  const result = readConfig(ctxCwd);
  const workingDir = result.ok ? result.config.workingDir : undefined;
  if (!workingDir) return ctxCwd;
  return path.isAbsolute(workingDir) ? workingDir : path.resolve(ctxCwd, workingDir);
}

export function validateWorkDir(ctxCwd: string): string | null {
  const config = readConfig(ctxCwd);
  if (!config.ok) return config.error;

  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from goal.config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from goal.config.json) does not exist.`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
