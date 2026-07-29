import { fingerprintOf, type Finding, type ProposedGuideline } from "../domain/finding.js";
import type { RejectedCandidate } from "./parse.js";

const REJECTED_CAP = 200;
import type { GateDecision } from "../domain/gate.js";
import type { ModelUsage } from "../model/port.js";
import type { ComputedCost } from "../model/usage.js";

/**
 * A finding as rendered in the report; already carries its own optional
 * `calibration` note (from `Finding`) when the calibration pass disagreed —
 * advisory only, never gating (ADR 0008).
 */
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

/**
 * A batch whose model reply held no parseable findings at all -- distinct from
 * droppedMalformedFindings, which counts individual malformed elements inside
 * an otherwise-parseable reply. Every other batch's findings still stand.
 */
export interface UnparsedBatch {
  /** 1-based, matching the "batch N/M" language in the warning this came from. */
  batch: number;
  of: number;
  /** The parse failure's own message (e.g. "model response held no JSON object"). */
  reason: string;
}

export interface ReviewReport {
  version: 1;
  /** Rendered findings: violations and observations at or above the confidence floor. */
  findings: ReportedFinding[];
  /** Violations excused by an in-code waiver: recorded, never gating. */
  waived?: WaivedFinding[];
  /** Raw payloads the parser refused, next to the drop counts; capped. */
  rejectedCandidates?: RejectedCandidate[];
  /** Findings under the confidence floor; kept for tuning, never rendered or posted. */
  filtered: ReportedFinding[];
  proposedGuidelines: ProposedGuideline[];
  droppedUncitedFindings: number;
  /** Violations whose cited guideline declares a scope excluding the file. */
  droppedOutOfScopeFindings: number;
  /** Violations whose structural claim (loop, module scope) the AST contradicted (ADR 0008: deterministic, so it may gate). */
  droppedStructuralFindings: number;
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
  /** The review reply came from the response cache; no model was called. */
  cachedResponse?: true;
  /** At least one batch could not afford its context; batching alone does not count. */
  budgetDegraded?: true;
  /** Linters and formatters detected in the tree, whose rules the review skips. */
  lintersDetected?: string[];
  /** Batches whose reply held no parseable findings; every other batch's findings still stand. */
  unparsedBatches?: UnparsedBatch[];
}

export function buildReport(input: {
  findings: readonly Finding[];
  filtered: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  droppedOutOfScope?: number;
  droppedStructural?: number;
  adjustedLines: number;
  droppedMalformed?: number;
  redactions?: Record<string, number>;
  gate: GateDecision;
  usage?: ModelUsage;
  cost?: ComputedCost;
  ensemble?: ReviewReport["ensemble"];
  budget?: ReviewReport["budget"];
  toolCalls?: number;
  cachedResponse?: true;
  budgetDegraded?: true;
  lintersDetected?: string[];
  /** Batches whose reply could not be parsed; recorded so a caller can tell a partial review from a complete one. */
  unparsedBatches?: readonly UnparsedBatch[];
  /** Findings the baseline accepted; they join findings flagged, never gate. */
  baselined?: readonly Finding[];
  /** Violations an in-code waiver excused; recorded separately, never gating. */
  waived?: readonly WaivedFinding[];
  /** Payloads the parser refused; recorded (capped) next to the drop counts. */
  rejected?: readonly RejectedCandidate[];
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
    ...(input.rejected && input.rejected.length > 0
      ? { rejectedCandidates: input.rejected.slice(0, REJECTED_CAP) }
      : {}),
    proposedGuidelines: [...input.proposals],
    droppedUncitedFindings: input.droppedUncited,
    droppedOutOfScopeFindings: input.droppedOutOfScope ?? 0,
    droppedStructuralFindings: input.droppedStructural ?? 0,
    adjustedLines: input.adjustedLines,
    droppedMalformedFindings: input.droppedMalformed ?? 0,
    redactions: input.redactions ?? {},
    gate: input.gate,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.cost ? { cost: input.cost } : {}),
    ...(input.ensemble ? { ensemble: input.ensemble } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.cachedResponse ? { cachedResponse: input.cachedResponse } : {}),
    ...(input.budgetDegraded ? { budgetDegraded: input.budgetDegraded } : {}),
    ...(input.lintersDetected ? { lintersDetected: input.lintersDetected } : {}),
    ...(input.unparsedBatches && input.unparsedBatches.length > 0
      ? { unparsedBatches: [...input.unparsedBatches] }
      : {}),
  };
}
