import type { Violation } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";

export interface RenderableReview {
  violations: readonly Violation[];
  droppedUncited: number;
  adjustedLines: number;
  gate: GateDecision;
}

function violationLines(violation: Violation): string[] {
  const head = `${violation.severity.padEnd(8)} ${violation.file}:${String(violation.line)}  [${violation.guidelineId}] ${violation.title}`;
  return violation.body === "" ? [head] : [head, `         ${violation.body}`];
}

function gateLine(gate: GateDecision): string {
  if (gate.threshold === "none") return "gate: advisory";
  if (gate.failed) {
    return `gate: failOn=${gate.threshold} FAILED (${String(gate.failing)} at or above threshold)`;
  }
  return `gate: failOn=${gate.threshold} passed`;
}

export function renderReview(review: RenderableReview): string {
  const findings =
    review.violations.length === 0
      ? ["No findings."]
      : [
          ...review.violations.flatMap(violationLines),
          "",
          `${String(review.violations.length)} finding(s)`,
        ];
  const notices = [
    ...(review.droppedUncited > 0
      ? [`${String(review.droppedUncited)} uncited finding(s) dropped`]
      : []),
    ...(review.adjustedLines > 0
      ? [`${String(review.adjustedLines)} finding(s) had no usable line and were pinned to line 1`]
      : []),
  ];
  return `${[...findings, ...notices, gateLine(review.gate)].join("\n")}\n`;
}
