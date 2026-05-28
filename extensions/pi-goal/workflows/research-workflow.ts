export type { LogRunParams } from "../domain/run-result.ts";
export { isBetter } from "../domain/research-state.ts";

export {
  executeExperimentConfigWorkflow,
} from "./experiment-config-workflow.ts";
export type {
  ExperimentConfigKind,
  ExperimentConfigParams,
  ExperimentConfigWorkflowBlocked,
  ExperimentConfigWorkflowDeps,
  ExperimentConfigWorkflowResult,
  ExperimentConfigWorkflowSuccess,
} from "./experiment-config-workflow.ts";

export {
  formatResearchValidationResult,
  validateResearch,
} from "./research-validation-workflow.ts";
export type {
  ResearchValidationIssue,
  ResearchValidationResult,
  ValidatorExecAdapter,
} from "./research-validation-workflow.ts";

export {
  executeRunExperimentWorkflow,
} from "./run-experiment-workflow.ts";
export type {
  RunExperimentWorkflowBlocked,
  RunExperimentWorkflowDeps,
  RunExperimentWorkflowParams,
  RunExperimentWorkflowResult,
  RunExperimentWorkflowSuccess,
} from "./run-experiment-workflow.ts";

export { recordRunResult } from "./run-result-recording.ts";
export type {
  RecordRunResult,
  RecordRunResultDeps,
} from "./run-result-recording.ts";
