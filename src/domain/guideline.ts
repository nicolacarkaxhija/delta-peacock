import type { Severity } from "./severity.js";

export interface Guideline {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  sourcePath: string;
  /** Empty means the guideline covers every language. */
  languages: readonly string[];
  /** Path globs the guideline is scoped to; empty means everywhere. */
  paths: readonly string[];
  tags: readonly string[];
}
