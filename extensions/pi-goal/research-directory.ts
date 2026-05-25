import * as fs from "node:fs";
import * as path from "node:path";

export const RESEARCH_ROOT_DIR = ".goal";
export const RESEARCHES_DIR = "researches";
export const ACTIVE_RESEARCH_FILE = "active";
export const DEFAULT_RESEARCH_ID = "default";

export function researchRootPath(projectDir: string): string {
  return path.join(projectDir, RESEARCH_ROOT_DIR);
}

export function researchDirectory(projectDir: string, researchId = DEFAULT_RESEARCH_ID): string {
  return path.join(researchRootPath(projectDir), RESEARCHES_DIR, sanitizeResearchId(researchId));
}

export function activeResearchPath(projectDir: string): string {
  return path.join(researchRootPath(projectDir), ACTIVE_RESEARCH_FILE);
}

export function activeResearchId(projectDir: string): string {
  const activePath = activeResearchPath(projectDir);
  if (!fs.existsSync(activePath)) return DEFAULT_RESEARCH_ID;
  const id = fs.readFileSync(activePath, "utf-8").trim();
  return id ? sanitizeResearchId(id) : DEFAULT_RESEARCH_ID;
}

export function activeResearchDirectory(projectDir: string): string {
  return researchDirectory(projectDir, activeResearchId(projectDir));
}

export function ensureActiveResearchDirectory(projectDir: string): string {
  const id = activeResearchId(projectDir);
  const dir = researchDirectory(projectDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const activePath = activeResearchPath(projectDir);
  if (!fs.existsSync(activePath)) {
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.writeFileSync(activePath, id + "\n");
  }
  return dir;
}

export function sanitizeResearchId(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || DEFAULT_RESEARCH_ID;
}
