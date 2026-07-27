import type { CiProvider } from "./config/ci.js";
import type { Credentials } from "./config/credentials.js";
import type { Config } from "./config/schema.js";
import type { EmbeddingPort } from "./context/embedding.js";
import type { ModelRef } from "./model/build.js";
import type { ModelPort } from "./model/port.js";
import type { ScmPort } from "./scm/port.js";

/**
 * The dependencies every command runs against; tests inject all of them.
 *
 * Nothing here is raw environment: the composition root (runCli) is the only
 * place that ever holds `process.env`, and reduces it once into `loadConfig`,
 * `credentials` and `ci` before a command ever sees it (ADR 0005 — the config
 * loader, and this same boundary for the ambient values Config never
 * carries, are the only readers of the environment in the whole codebase).
 */
export interface RuntimeDeps {
  cwd: string;
  /** Resolves the effective config for a command's flags; env and root are already closed over. */
  loadConfig: (flags?: Readonly<Record<string, string>>) => Config;
  /** Credential-shaped env vars the model/SCM adapters need. */
  credentials: Credentials;
  /** Which CI host this process runs under, if any. */
  ci: CiProvider;
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
