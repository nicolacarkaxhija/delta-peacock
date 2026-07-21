import { createHash } from "node:crypto";
import type { Severity } from "./severity.js";

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
}

export type Finding = Violation | Observation;

/** Stable identity of a finding; the basis for idempotent reporting. */
export function fingerprintOf(finding: Finding): string {
  const anchor =
    finding.kind === "violation"
      ? finding.guidelineId
      : `observation:${finding.title.toLowerCase()}`;
  const material = [finding.file, anchor, String(finding.line)].join("\u0000");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
