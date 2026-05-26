import * as fs from "node:fs";
import * as path from "node:path";

export const RESEARCH_ROOT_DIR = ".goal";
export const RESEARCHES_DIR = "researches";
export const ACTIVE_RESEARCH_FILE = "active";
export const DEFAULT_RESEARCH_ID = "default";

export interface ResearchPaths {
  root: string;
  activeFile: string;
  directory: string;
  journal: string;
  rules: string;
  ideas: string;
  checks: string;
  script: string;
}

export interface ActiveResearch {
  projectDir: string;
  id: string;
  paths: ResearchPaths;
}

export function researchConfigPath(projectDir: string): string {
  return path.join(projectDir, "goal.config.json");
}

export function isResearchStatePath(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((part) => part === ".goal" || part === "goal.hooks" || part.startsWith("goal."));
}

export function activeResearch(projectDir: string): ActiveResearch {
  return researchFor(projectDir, readActiveResearchId(projectDir));
}

export function ensureActiveResearch(projectDir: string): ActiveResearch {
  const research = activeResearch(projectDir);
  fs.mkdirSync(research.paths.directory, { recursive: true });
  if (!fs.existsSync(research.paths.activeFile)) {
    fs.mkdirSync(path.dirname(research.paths.activeFile), { recursive: true });
    fs.writeFileSync(research.paths.activeFile, research.id + "\n");
  }
  return research;
}

export function selectActiveResearch(projectDir: string, requestedResearchId: string): ActiveResearch {
  const research = researchFor(projectDir, requestedResearchId);
  fs.mkdirSync(path.dirname(research.paths.activeFile), { recursive: true });
  fs.writeFileSync(research.paths.activeFile, research.id + "\n");
  fs.mkdirSync(research.paths.directory, { recursive: true });
  return research;
}

export function sanitizeResearchId(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || DEFAULT_RESEARCH_ID;
}

function readActiveResearchId(projectDir: string): string {
  const activePath = path.join(projectDir, RESEARCH_ROOT_DIR, ACTIVE_RESEARCH_FILE);
  if (!fs.existsSync(activePath)) return DEFAULT_RESEARCH_ID;
  const id = fs.readFileSync(activePath, "utf-8").trim();
  return id ? sanitizeResearchId(id) : DEFAULT_RESEARCH_ID;
}

function researchFor(projectDir: string, researchId: string): ActiveResearch {
  const id = sanitizeResearchId(researchId);
  const root = path.join(projectDir, RESEARCH_ROOT_DIR);
  const directory = path.join(root, RESEARCHES_DIR, id);
  return {
    projectDir,
    id,
    paths: {
      root,
      activeFile: path.join(root, ACTIVE_RESEARCH_FILE),
      directory,
      journal: path.join(directory, "goal.jsonl"),
      rules: path.join(directory, "goal.md"),
      ideas: path.join(directory, "goal.ideas.md"),
      checks: path.join(directory, "goal.checks.sh"),
      script: path.join(directory, "goal.sh"),
    },
  };
}
