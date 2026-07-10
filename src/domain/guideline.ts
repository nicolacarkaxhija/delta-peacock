import type { Severity } from "./severity.js";

export interface Guideline {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  sourcePath: string;
}
