import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { currentRuns, type ResearchState } from "../domain/research-state.ts";
import {
  isGoalShCommand,
  runExperiment,
  type ExperimentRunUpdate,
  type RunDetails,
} from "../execution/experiment-runner.ts";
import { shouldUseScriptCommandOnly } from "../execution/research-command-policy.ts";
import { readResearchFileContract } from "../persistence/research-files.ts";
import {
  onResearchRunFinished,
  researchAwaitingLogBlockMessage,
  shouldBlockResearchRun,
} from "../protocol/research-phase.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { buildRunExperimentResponseText } from "../ui/run-result-renderer.ts";

export interface RunExperimentWorkflowParams {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

export interface RunExperimentWorkflowDeps {
  pi: Pick<ExtensionAPI, "exec">;
  workDir: string;
  runtime: SessionRuntime;
  signal?: AbortSignal;
  onUpdate?: (update: ExperimentRunUpdate) => void;
  onActiveRunChange(): void;
}

export interface RunExperimentWorkflowBlocked {
  ok: false;
  text: string;
  details?: RunDetails;
}

export interface RunExperimentWorkflowSuccess {
  ok: true;
  text: string;
  details: RunDetails & { truncation?: unknown; fullOutputPath?: string };
}

export type RunExperimentWorkflowResult = RunExperimentWorkflowBlocked | RunExperimentWorkflowSuccess;

export async function executeRunExperimentWorkflow(
  params: RunExperimentWorkflowParams,
  deps: RunExperimentWorkflowDeps,
): Promise<RunExperimentWorkflowResult> {
  const { runtime, workDir } = deps;
  const state = runtime.state;

  if (shouldBlockResearchRun(runtime.loop)) {
    return { ok: false, text: researchAwaitingLogBlockMessage(runtime.loop) };
  }

  if (state.runLimit !== null) {
    const runCount = currentRuns(state.results, state.currentExperimentIndex).length;
    if (runCount >= state.runLimit) {
      return {
        ok: false,
        text: `🛑 Maximum runs reached (${state.runLimit}) for the current experiment. To continue with a fresh baseline, call start_goal.`,
      };
    }
  }

  const fileContract = readResearchFileContract(workDir);
  if (shouldUseScriptCommandOnly(fileContract) && !isGoalShCommand(params.command)) {
    return {
      ok: false,
      text: `❌ goal.sh exists — you must run it instead of a custom command.\n\nFound: ${fileContract.scriptPath}\nYour command: ${params.command}\n\nUse: run_goal({ command: "bash goal.sh" }) or run_goal({ command: "./goal.sh" })`,
      details: blockedRunDetails(params.command, state.metricName, state.metricUnit),
    };
  }

  runtime.activeRun = { startedAt: Date.now(), command: params.command };
  deps.onActiveRunChange();

  const { details, llmOutput, truncation, fullOutputPath } = await runExperiment({
    command: params.command,
    workDir,
    timeoutSeconds: params.timeout_seconds,
    checksTimeoutSeconds: params.checks_timeout_seconds,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    signal: deps.signal,
    onUpdate: deps.onUpdate,
    pi: deps.pi,
  }).finally(() => {
    runtime.activeRun = null;
    deps.onActiveRunChange();
  });

  runtime.lastRunDuration = details.durationSeconds;
  runtime.lastRunChecks = details.checksPass !== null
    ? { pass: details.checksPass, output: details.checksOutput, duration: details.checksDuration }
    : null;

  onResearchRunFinished(runtime.loop, lastRunSummaryFromDetails(details));

  const text = buildRunExperimentResponseText({
    details,
    llmOutput,
    truncation,
    fullOutputPath,
    requirePrimaryMetric: shouldUseScriptCommandOnly(fileContract),
    bestMetric: state.bestMetric,
  });

  return {
    ok: true,
    text,
    details: { ...details, truncation, fullOutputPath },
  };
}

function blockedRunDetails(command: string, metricName: string, metricUnit: string): RunDetails {
  return {
    command,
    exitCode: null,
    durationSeconds: 0,
    passed: false,
    crashed: true,
    timedOut: false,
    tailOutput: "",
    checksPass: null,
    checksTimedOut: false,
    checksOutput: "",
    checksDuration: 0,
    parsedMetrics: null,
    parsedPrimary: null,
    metricName,
    metricUnit,
  };
}

function lastRunSummaryFromDetails(details: RunDetails) {
  return {
    command: details.command,
    passed: details.passed,
    crashed: details.crashed,
    timedOut: details.timedOut,
    checksPass: details.checksPass,
    checksTimedOut: details.checksTimedOut,
    parsedPrimary: details.parsedPrimary,
    parsedMetrics: details.parsedMetrics,
    metricName: details.metricName,
    metricUnit: details.metricUnit,
  };
}
