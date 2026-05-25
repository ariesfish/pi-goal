import type { ResearchFileContract } from "../persistence/research-files.ts";

export function shouldUseScriptCommandOnly(contract: ResearchFileContract): boolean {
  return contract.hasBenchmarkScript && !contract.invalidBenchmarkScript;
}
