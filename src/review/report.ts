import { fingerprintOf, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { SuppressedFinding } from "./calibrate.js";
import type { GateDecision } from "../domain/gate.js";
import type { ModelUsage } from "../model/port.js";
import type { ComputedCost } from "../model/usage.js";

export type ReportedFinding = Finding & {
  fingerprint: string;
  /** The flagged line's text at review time; the fix command's safety anchor. */
  lineText?: string;
};

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
  /** Present when the ensemble reviewed; usage is attributed per member. */
  ensemble?: {
    mode: "union" | "judge";
    members: { provider: string; id: string; ok: boolean; usage?: ModelUsage; error?: string }[];
  };
  /** Present when the cost guard blocked the review before any model call. */
  budget?: {
    blocked: true;
    estimated: number;
    monthToDate?: number;
    reasons: string[];
  };
  /** How many agentic context tools the model invoked. */
  toolCalls?: number;
  /** Present when calibration ran; every suppression carries its reason. */
  calibration?: { suppressed: SuppressedFinding[] };
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
  ensemble?: ReviewReport["ensemble"];
  budget?: ReviewReport["budget"];
  toolCalls?: number;
  calibration?: ReviewReport["calibration"];
  /** Looks up the flagged line's text; absent entries simply carry none. */
  lineTextOf?: (finding: Finding) => string | undefined;
}): ReviewReport {
  const withFingerprint = (finding: Finding): ReportedFinding => {
    const lineText = input.lineTextOf?.(finding);
    return {
      ...finding,
      fingerprint: fingerprintOf(finding),
      ...(lineText !== undefined ? { lineText } : {}),
    };
  };
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
    ...(input.ensemble ? { ensemble: input.ensemble } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.calibration ? { calibration: input.calibration } : {}),
  };
}
