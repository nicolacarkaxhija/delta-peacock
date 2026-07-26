import { createHash } from "node:crypto";
import type { Severity } from "./severity.js";

/**
 * Advisory-only note from the calibration pass: what it would have done, had
 * it been allowed to gate. It never changes a finding's kind, severity, or
 * gate membership (ADR 0008) — attaching one is the only effect calibration
 * has on a finding, purely so a human can triage it in the report.
 */
export interface CalibrationNote {
  action: "drop" | "demote";
  reason: string;
}

export interface Violation {
  kind: "violation";
  guidelineId: string;
  /** Name of the pack the cited guideline came from; absent for local rules. */
  pack?: string;
  /** Inherited from the cited guideline; the model never assigns it. */
  severity: Severity;
  file: string;
  line: number;
  title: string;
  body: string;
  /** The model's certainty, 0 to 1; absent means fully confident. */
  confidence?: number;
  /** Replacement code for the flagged lines, rendered as a one-click suggestion. */
  suggestion?: string;
  /** Present when the calibration pass disagreed; advisory only, never gates. */
  calibration?: CalibrationNote;
}

export interface ProposedGuideline {
  id: string;
  severity: Severity;
  rationale: string;
}

/** A general-pass finding citing no guideline. Severity-capped, never gates. */
export interface Observation {
  kind: "observation";
  severity: Severity;
  file: string;
  line: number;
  title: string;
  body: string;
  confidence?: number;
  suggestion?: string;
  proposedGuideline?: ProposedGuideline;
  /** Present when the calibration pass disagreed; advisory only, never gates. */
  calibration?: CalibrationNote;
}

export type Finding = Violation | Observation;

/**
 * Stable identity of a finding; the basis for idempotent reporting. A
 * violation keys on its cited guideline, which is fixed regardless of how
 * the model phrases the finding. An observation cites no guideline, so it
 * keys on file + line + kind instead of its freeform title: title is model
 * prose, and the same problem can be worded differently across runs, which
 * would otherwise fingerprint identically-located observations differently
 * on every re-run.
 */
export function fingerprintOf(finding: Finding): string {
  const anchor = finding.kind === "violation" ? finding.guidelineId : finding.kind;
  const material = [finding.file, anchor, String(finding.line)].join("\u0000");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
