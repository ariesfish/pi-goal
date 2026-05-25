import * as path from "node:path";

import { activeResearchDirectory, ensureActiveResearchDirectory } from "./research-directory.ts";

export const researchJournalPath = (projectDir: string) => path.join(activeResearchDirectory(projectDir), "goal.jsonl");
export const researchRulesPath = (projectDir: string) => path.join(activeResearchDirectory(projectDir), "goal.md");
export const researchIdeasPath = (projectDir: string) => path.join(activeResearchDirectory(projectDir), "goal.ideas.md");
export const researchChecksPath = (projectDir: string) => path.join(activeResearchDirectory(projectDir), "goal.checks.sh");
export const researchScriptPath = (projectDir: string) => path.join(activeResearchDirectory(projectDir), "goal.sh");
export const ensureResearchJournalPath = (projectDir: string) => path.join(ensureActiveResearchDirectory(projectDir), "goal.jsonl");
export const ensureResearchRulesPath = (projectDir: string) => path.join(ensureActiveResearchDirectory(projectDir), "goal.md");
export const ensureResearchIdeasPath = (projectDir: string) => path.join(ensureActiveResearchDirectory(projectDir), "goal.ideas.md");
export const ensureResearchChecksPath = (projectDir: string) => path.join(ensureActiveResearchDirectory(projectDir), "goal.checks.sh");
export const ensureResearchScriptPath = (projectDir: string) => path.join(ensureActiveResearchDirectory(projectDir), "goal.sh");
export const researchConfigPath = (dir: string) => path.join(dir, "goal.config.json");

export function isResearchStatePath(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((part) => part === ".goal" || part === "goal.hooks" || part.startsWith("goal."));
}
