import { fingerprintOf, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { SuppressedFinding } from "./calibrate.js";
import type { GateDecision } from "../domain/gate.js";
import type { ModelUsage } from "../model/port.js";
import type { ComputedCost } from "../model/usage.js";

export type ReportedFinding = Finding & {
  fingerprint: string;
  /** The flagged line's text at review time; the fix command's safety anchor. */
  lineText?: string;
  /** Accepted as pre-existing; informs the reader, never the gate. */
  baselined?: true;
};

/** A violation an in-code waiver excused: recorded here, never gating (ADR 0008). */
export interface WaivedFinding {
  guidelineId: string;
  file: string;
  line: number;
  reason: string;
  until?: string;
  expired?: boolean;
}

export interface ReviewReport {
  version: 1;
  /** Rendered findings: violations and observations at or above the confidence floor. */
  findings: ReportedFinding[];
  /** Violations excused by an in-code waiver: recorded, never gating. */
  waived?: WaivedFinding[];
  /** Findings under the confidence floor; kept for tuning, never rendered or posted. */
  filtered: ReportedFinding[];
  proposedGuidelines: ProposedGuideline[];
  droppedUncitedFindings: number;
  /** Violations whose cited guideline declares a scope excluding the file. */
  droppedOutOfScopeFindings: number;
  adjustedLines: number;
  /** Findings the model returned in an unreadable shape (or a truncated tail). */
  droppedMalformedFindings: number;
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
  /** The review reply came from the response cache; no model was called. */
  cachedResponse?: true;
  /** The prompt exceeded the window; context was dropped or the diff batched. */
  budgetDegraded?: true;
  /** Linters and formatters detected in the tree, whose rules the review skips. */
  lintersDetected?: string[];
}

export function buildReport(input: {
  findings: readonly Finding[];
  filtered: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  droppedOutOfScope?: number;
  adjustedLines: number;
  droppedMalformed?: number;
  redactions?: Record<string, number>;
  gate: GateDecision;
  usage?: ModelUsage;
  cost?: ComputedCost;
  ensemble?: ReviewReport["ensemble"];
  budget?: ReviewReport["budget"];
  toolCalls?: number;
  calibration?: ReviewReport["calibration"];
  cachedResponse?: true;
  budgetDegraded?: true;
  lintersDetected?: string[];
  /** Findings the baseline accepted; they join findings flagged, never gate. */
  baselined?: readonly Finding[];
  /** Violations an in-code waiver excused; recorded separately, never gating. */
  waived?: readonly WaivedFinding[];
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
    findings: [
      ...input.findings.map(withFingerprint),
      ...(input.baselined ?? []).map((finding) => ({
        ...withFingerprint(finding),
        baselined: true as const,
      })),
    ],
    filtered: input.filtered.map(withFingerprint),
    ...(input.waived && input.waived.length > 0 ? { waived: [...input.waived] } : {}),
    proposedGuidelines: [...input.proposals],
    droppedUncitedFindings: input.droppedUncited,
    droppedOutOfScopeFindings: input.droppedOutOfScope ?? 0,
    adjustedLines: input.adjustedLines,
    droppedMalformedFindings: input.droppedMalformed ?? 0,
    redactions: input.redactions ?? {},
    gate: input.gate,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.cost ? { cost: input.cost } : {}),
    ...(input.ensemble ? { ensemble: input.ensemble } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.calibration ? { calibration: input.calibration } : {}),
    ...(input.cachedResponse ? { cachedResponse: input.cachedResponse } : {}),
    ...(input.budgetDegraded ? { budgetDegraded: input.budgetDegraded } : {}),
    ...(input.lintersDetected ? { lintersDetected: input.lintersDetected } : {}),
  };
}
