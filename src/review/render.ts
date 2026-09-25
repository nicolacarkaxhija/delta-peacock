import type { Finding, ProposedGuideline, Violation } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";

export interface RenderableReview {
  violations: readonly Violation[];
  observations: readonly Finding[];
  proposals: readonly ProposedGuideline[];
  droppedUncited: number;
  droppedOutOfScope?: number;
  /** Violations whose structural claim (loop, module scope) the AST contradicted. */
  droppedStructural?: number;
  adjustedLines: number;
  droppedMalformed?: number;
  /** Violations quoting a sentence their guideline does not contain. */
  droppedMisquoted?: number;
  /** How many findings sit under the confidence floor, report-only. */
  filtered: number;
  /** Violations excused by an in-code waiver: reported here, never gating. */
  waived?: readonly {
    guidelineId: string;
    file: string;
    line: number;
    reason: string;
    until?: string;
    expired?: boolean;
  }[];
  gate: GateDecision;
}

function findingLines(finding: Finding, badge: string): string[] {
  const head = `${badge}${finding.severity.padEnd(8)} ${finding.file}:${String(finding.line)}  ${
    finding.kind === "violation" ? `[${finding.guidelineId}]` : "[observation]"
  } ${finding.title}`;
  const lines = finding.body === "" ? [head] : [head, `         ${finding.body}`];
  if (finding.note !== undefined) lines.push(`         note: ${finding.note}`);
  // advisory only (ADR 0008): calibration never changed this finding's gate
  // membership, so its note is surfaced here for a human to triage, not acted on
  if (finding.calibration !== undefined) {
    lines.push(
      `         calibration: ${finding.calibration.action} — ${finding.calibration.reason}`,
    );
  }
  return lines;
}

function gateLine(gate: GateDecision): string {
  if (gate.threshold === "none") return "gate: advisory";
  if (gate.failed) {
    return `gate: failOn=${gate.threshold} FAILED (${String(gate.failing)} at or above threshold)`;
  }
  return `gate: failOn=${gate.threshold} passed`;
}

export function renderReview(review: RenderableReview): string {
  const sections: string[] = [];

  if (review.violations.length === 0 && review.observations.length === 0) {
    sections.push("No findings.");
  }
  if (review.violations.length > 0) {
    sections.push(
      ...review.violations.flatMap((violation) => findingLines(violation, "")),
      "",
      `${String(review.violations.length)} finding(s)`,
    );
  }
  if (review.observations.length > 0) {
    sections.push(
      "",
      "observations (general pass, never gate):",
      ...review.observations.flatMap((observation) => findingLines(observation, "~ ")),
    );
  }
  if (review.proposals.length > 0) {
    sections.push("", "proposed guidelines:");
    for (const proposal of review.proposals) {
      sections.push(`  ${proposal.id} (${proposal.severity}): ${proposal.rationale}`);
    }
  }
  if ((review.waived ?? []).length > 0) {
    sections.push("", "waived (never gate):");
    for (const entry of review.waived ?? []) {
      const stamp =
        entry.until === undefined
          ? ""
          : entry.expired === true
            ? ` (expired ${entry.until})`
            : ` (expires ${entry.until})`;
      sections.push(
        `  ${entry.guidelineId} @ ${entry.file}:${String(entry.line)} — ${entry.reason}${stamp}`,
      );
    }
  }

  const notices = [
    ...((review.droppedOutOfScope ?? 0) > 0
      ? [
          `${String(review.droppedOutOfScope ?? 0)} finding(s) dropped: cited guideline out of scope for the file`,
        ]
      : []),
    ...(review.droppedUncited > 0
      ? [`${String(review.droppedUncited)} uncited finding(s) dropped`]
      : []),
    ...((review.droppedStructural ?? 0) > 0
      ? [
          `${String(review.droppedStructural ?? 0)} finding(s) dropped: structural claim contradicted by the AST`,
        ]
      : []),
    ...(review.adjustedLines > 0
      ? [`${String(review.adjustedLines)} finding(s) had no usable line and were pinned to line 1`]
      : []),
    ...((review.droppedMalformed ?? 0) > 0
      ? [`${String(review.droppedMalformed ?? 0)} malformed finding(s) dropped`]
      : []),
    ...((review.droppedMisquoted ?? 0) > 0
      ? [
          `${String(review.droppedMisquoted ?? 0)} finding(s) dropped: the quoted rule is not in the cited guideline`,
        ]
      : []),
    ...(review.filtered > 0
      ? [`${String(review.filtered)} finding(s) under the confidence floor (report only)`]
      : []),
  ];
  return `${[...sections, ...notices, gateLine(review.gate)].join("\n")}\n`;
}
