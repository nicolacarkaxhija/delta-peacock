import { fingerprintOf, type Violation } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";
import type { ModelUsage } from "../model/port.js";

export interface ReviewReport {
  version: 1;
  findings: (Violation & { fingerprint: string })[];
  droppedUncitedFindings: number;
  adjustedLines: number;
  gate: GateDecision;
  usage?: ModelUsage;
}

export function buildReport(input: {
  violations: readonly Violation[];
  droppedUncited: number;
  adjustedLines: number;
  gate: GateDecision;
  usage?: ModelUsage;
}): ReviewReport {
  return {
    version: 1,
    findings: input.violations.map((violation) => ({
      ...violation,
      fingerprint: fingerprintOf(violation),
    })),
    droppedUncitedFindings: input.droppedUncited,
    adjustedLines: input.adjustedLines,
    gate: input.gate,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
