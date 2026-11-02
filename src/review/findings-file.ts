import type { ReportedFinding } from "./report.js";

export const FINDINGS_FILE = "reviewer.json";

export function renderFindingsFile(
  _findings: readonly ReportedFinding[],
  _evidence?: string,
): string {
  void _findings;
  void _evidence;
  throw new Error("not implemented");
}
