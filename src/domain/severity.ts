export const SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const;

export type Severity = (typeof SEVERITIES)[number];

/** Lower rank means more severe; BLOCKER is 0. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** Whether a finding of this severity trips a gate configured at the given threshold. */
export function meetsThreshold(severity: Severity, threshold: Severity | "none"): boolean {
  if (threshold === "none") return false;
  return severityRank(severity) <= severityRank(threshold);
}
