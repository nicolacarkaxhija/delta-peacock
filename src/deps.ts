import type { ModelPort } from "./model/port.js";

/** The dependencies every command runs against; tests inject all of them. */
export interface RuntimeDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** The model-port seam: tests inject a scripted fake here. */
  modelPort?: ModelPort;
}
