import { CommanderError } from "commander";
import { ciBuildUrl, detectCi } from "./config/ci.js";
import { loadCredentials } from "./config/credentials.js";
import { ConfigError, loadConfig } from "./config/loader.js";
import type { EmbeddingPort } from "./context/embedding.js";
import type { RuntimeDeps } from "./deps.js";
import { ExitCodeError } from "./errors.js";
import type { ModelRef } from "./model/build.js";
import type { ModelPort } from "./model/port.js";
import { buildProgram } from "./program.js";
import type { ScmPort } from "./scm/port.js";

/**
 * The raw boundary a real process (or a test) hands the CLI: cwd and env are
 * still just what the OS gives a process. This is the only shape in the
 * codebase where env is a plain, undifferentiated bag — runCli reduces it
 * once into RuntimeDeps's typed loadConfig, credentials and ci before any
 * command runs (ADR 0005: nothing past this boundary reads raw environment).
 */
export interface CliDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** The model-port seam: tests inject a scripted fake here. */
  modelPort?: ModelPort;
  /** SCM override; adapters are normally tested at the HTTP boundary instead. */
  scmPort?: ScmPort;
  /** Per-member model ports for ensemble tests; falls back to real adapters. */
  modelPortFor?: (member: ModelRef) => ModelPort;
  /** Injectable time for monthly-cap rollover; defaults to the system clock. */
  clock?: () => Date;
  /** Line source for interactive commands; null means end of input. Tests inject it. */
  readLine?: () => Promise<string | null>;
  /** Embedding seam for the rag embeddings backend; real adapters otherwise. */
  embeddingPort?: EmbeddingPort;
}

function toRuntimeDeps(boundary: CliDeps): RuntimeDeps {
  const { cwd, env, ...rest } = boundary;
  const buildUrl = ciBuildUrl(env);
  return {
    cwd,
    loadConfig: (flags) =>
      loadConfig({
        root: cwd,
        env,
        ...(flags !== undefined ? { flags } : {}),
        onNotice: (notice) => {
          boundary.err(`${notice}\n`);
        },
      }),
    credentials: loadCredentials(env),
    ci: detectCi(env),
    ...(buildUrl !== undefined ? { ciBuildUrl: buildUrl } : {}),
    ...rest,
  };
}

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
  const program = buildProgram(toRuntimeDeps(deps));
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
