import * as fs from "node:fs";
import * as path from "node:path";

import { researchConfigPath } from "./research-directory.ts";

export interface ResearchConfig {
  maxIterations?: number;
  workingDir?: string;
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

  return { ok: true, config, error: null };
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
