import { fingerprintOf, type Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import type { PostingContext, PostingRule } from "../domain/hold.js";

/** The option the prompt and the parser take under posting on evidence. */
export function evidenceFlag(review: PostingRule): { evidence?: true } {
  return review.posting === "evidence" ? { evidence: true } : {};
}

/** The posting context of each finding: a model finding whose exclusion check was skipped, and that no check found too, asked no verdict. */
export function skippedCheckContext(
  skipped: readonly Finding[],
  fromChecks: readonly Finding[],
  guidelinesById: ReadonlyMap<string, Pick<Guideline, "exclusions">>,
): (finding: Finding) => PostingContext {
  const fromCheck = new Set(fromChecks.map(fingerprintOf));
  const unchecked = new Set(
    skipped.map(fingerprintOf).filter((fingerprint) => !fromCheck.has(fingerprint)),
  );
  return (finding) =>
    finding.kind === "violation" && unchecked.has(fingerprintOf(finding))
      ? { verdictsAsked: false, guideline: guidelinesById.get(finding.guidelineId) }
      : {};
}
