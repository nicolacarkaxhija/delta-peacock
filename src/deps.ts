import type { EmbeddingPort } from "./context/embedding.js";
import type { ModelRef } from "./model/build.js";
import type { ModelPort } from "./model/port.js";
import type { ScmPort } from "./scm/port.js";

/** The dependencies every command runs against; tests inject all of them. */
export interface RuntimeDeps {
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
