import type { Finding } from "./finding.js";
import { meetsThreshold, type Severity } from "./severity.js";

export interface GateDecision {
  threshold: Severity | "none";
  failing: number;
  failed: boolean;
}

export function evaluateGate(
  findings: readonly Finding[],
  threshold: Severity | "none",
): GateDecision {
  const failing = findings.filter((finding) => meetsThreshold(finding.severity, threshold)).length;
  return { threshold, failing, failed: failing > 0 };
}
