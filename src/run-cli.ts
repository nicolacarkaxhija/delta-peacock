import { CommanderError } from "commander";
import { ConfigError } from "./config/loader.js";
import { ExitCodeError } from "./errors.js";
import { buildProgram, type CliDeps } from "./program.js";

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    try {
      // JSON.stringify's type says string, but a toJSON returning undefined yields undefined
      const text = JSON.stringify(error) as string | undefined;
      return text ?? "unserializable error";
    } catch {
      return "unserializable error";
    }
  }
  return String(error);
}

/**
 * Runs the CLI against injected dependencies and returns the process exit code.
 * Exit contract: 0 clean, 1 tool error, 2 gate failure (owned by the review command).
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof ExitCodeError) {
      return error.code;
    }
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 1;
    }
    if (error instanceof ConfigError) {
      for (const problem of error.problems) deps.err(`${problem}\n`);
      deps.err(`invalid configuration: ${String(error.problems.length)} problem(s)\n`);
      return 1;
    }
    deps.err(`${describeError(error)}\n`);
    return 1;
  }
}
