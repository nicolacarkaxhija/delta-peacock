import type { Violation } from "../domain/finding.js";
import type { GateDecision } from "../domain/gate.js";

export interface RenderableReview {
  violations: readonly Violation[];
  droppedUncited: number;
  gate: GateDecision;
}

export function renderReview(review: RenderableReview): string {
  const lines: string[] = [];
  if (review.violations.length === 0) {
    lines.push("No findings.");
  } else {
    for (const violation of review.violations) {
      lines.push(
        `${violation.severity.padEnd(8)} ${violation.file}:${String(violation.line)}  [${violation.guidelineId}] ${violation.title}`,
      );
      if (violation.body !== "") lines.push(`         ${violation.body}`);
    }
    lines.push("");
    lines.push(`${String(review.violations.length)} finding(s)`);
  }
  if (review.droppedUncited > 0) {
    lines.push(`${String(review.droppedUncited)} uncited finding(s) dropped`);
  }
  lines.push(
    review.gate.threshold === "none"
      ? "gate: advisory"
      : review.gate.failed
        ? `gate: failOn=${review.gate.threshold} FAILED (${String(review.gate.failing)} at or above threshold)`
        : `gate: failOn=${review.gate.threshold} passed`,
  );
  return `${lines.join("\n")}\n`;
}
