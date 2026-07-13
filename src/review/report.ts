import { fingerprintOf, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";
import type { ModelUsage } from "../model/port.js";
import type { ComputedCost } from "../model/usage.js";

export type ReportedFinding = Finding & { fingerprint: string };

export interface ReviewReport {
  version: 1;
  /** Rendered findings: violations and observations at or above the confidence floor. */
  findings: ReportedFinding[];
  /** Findings under the confidence floor; kept for tuning, never rendered or posted. */
  filtered: ReportedFinding[];
  proposedGuidelines: ProposedGuideline[];
  droppedUncitedFindings: number;
  adjustedLines: number;
  /** Replacement counts per redaction pattern that fired. */
  redactions: Record<string, number>;
  gate: GateDecision;
  usage?: ModelUsage;
  /** Present when any cost rate is configured. */
  cost?: ComputedCost;
}

export function buildReport(input: {
  findings: readonly Finding[];
  filtered: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  adjustedLines: number;
  redactions?: Record<string, number>;
  gate: GateDecision;
  usage?: ModelUsage;
  cost?: ComputedCost;
}): ReviewReport {
  const withFingerprint = (finding: Finding): ReportedFinding => ({
    ...finding,
    fingerprint: fingerprintOf(finding),
  });
  return {
    version: 1,
    findings: input.findings.map(withFingerprint),
    filtered: input.filtered.map(withFingerprint),
    proposedGuidelines: [...input.proposals],
    droppedUncitedFindings: input.droppedUncited,
    adjustedLines: input.adjustedLines,
    redactions: input.redactions ?? {},
    gate: input.gate,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.cost ? { cost: input.cost } : {}),
  };
}
