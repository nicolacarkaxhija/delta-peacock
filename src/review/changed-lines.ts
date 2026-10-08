import type { Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import type { RejectedCandidate } from "./parse.js";

export interface ChangedLinesOutcome {
  kept: Finding[];
  dropped: RejectedCandidate[];
}

/** The new file lines a finding covers: its line plus every further line its quote spans. */
function spanOf(finding: Finding): number[] {
  const height = Math.max(1, (finding.quote ?? "").replace(/\n+$/, "").split("\n").length);
  return Array.from({ length: height }, (_, index) => finding.line + index);
}

/**
 * Keeps a model finding only where the change added or edited a line under
 * it; hunk context does not count. A guideline that declares `scope: file`,
 * a finding with no line and an observation pass unchanged.
 */
export function keepOnChangedLines(
  findings: readonly Finding[],
  addedLines: ReadonlyMap<string, ReadonlyMap<number, string>>,
  guidelinesById: ReadonlyMap<string, Pick<Guideline, "scope">>,
): ChangedLinesOutcome {
  const kept: Finding[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const finding of findings) {
    const added = addedLines.get(finding.file);
    if (
      finding.kind !== "violation" ||
      finding.unplaced === true ||
      guidelinesById.get(finding.guidelineId)?.scope === "file" ||
      spanOf(finding).some((line) => added?.has(line) === true)
    ) {
      kept.push(finding);
      continue;
    }
    dropped.push({
      reason: "off-change",
      raw: JSON.stringify({ file: finding.file, line: finding.line, quote: finding.quote }),
      guidelineId: finding.guidelineId,
      title: finding.title,
    });
  }
  return { kept, dropped };
}
