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
  // observations never gate, whatever their severity
  const failing = findings.filter(
    (finding) => finding.kind === "violation" && meetsThreshold(finding.severity, threshold),
  ).length;
  return { threshold, failing, failed: failing > 0 };
}
