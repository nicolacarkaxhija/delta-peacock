export { ConfigSchema, type Config } from "./config/schema.js";
export {
  CONFIG_FILE_NAME,
  ConfigError,
  ENV_VARS,
  loadConfig,
  type LoadConfigOptions,
} from "./config/loader.js";
export { SEVERITIES, meetsThreshold, severityRank, type Severity } from "./domain/severity.js";
export { fingerprintOf, type Finding, type Violation } from "./domain/finding.js";
export { evaluateGate, type GateDecision } from "./domain/gate.js";
export { type Guideline } from "./domain/guideline.js";
export { ExitCodeError, ToolError } from "./errors.js";
export { mergeBaseDiff } from "./git/diff.js";
export { loadGuidelines, type LoadedGuidelines } from "./guidelines/loader.js";
export { createAnthropicPort } from "./model/anthropic.js";
export { buildModelPort } from "./model/build.js";
export type { ModelPort, ModelReply, ModelRequest, ModelUsage } from "./model/port.js";
export { parseReviewResponse, type ParsedReview } from "./review/parse.js";
export { buildReviewPrompt } from "./review/prompt.js";
export { buildReport, type ReviewReport } from "./review/report.js";
export { runReview, type ReviewDeps } from "./review/run-review.js";
export { buildProgram, type CliDeps } from "./program.js";
export { runCli } from "./run-cli.js";
