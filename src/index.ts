export { ConfigSchema, type Config } from "./config/schema.js";
export {
  CONFIG_FILE_NAME,
  ConfigError,
  ENV_VARS,
  loadConfig,
  type LoadConfigOptions,
} from "./config/loader.js";
export { SEVERITIES, type Severity } from "./domain/severity.js";
export { buildProgram, type CliDeps } from "./program.js";
export { runCli } from "./run-cli.js";
