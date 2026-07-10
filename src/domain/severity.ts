export const SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const;

export type Severity = (typeof SEVERITIES)[number];
