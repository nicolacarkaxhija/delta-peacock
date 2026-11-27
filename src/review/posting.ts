import type { Config } from "../config/schema.js";
import { fingerprintOf, type Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";

type Review = Pick<Config["review"], "posting" | "confidenceFloor">;

/** What the caller knows about a finding beyond itself. */
export interface PostingContext {
  /** False where no exclusion verdict was asked, as in audit. */
  verdictsAsked?: boolean;
  guideline?: Pick<Guideline, "exclusions"> | undefined;
}

/**
 * Whether a finding that survived every validator is posted. Under evidence a
 * violation stands on what was checked (a whole rule sentence at parse, its
 * quote placed on a line of the change, a cleared exclusion verdict), so a
 * sampled confidence near the floor cannot flip it between runs; one whose
 * quote could not be placed, or whose exclusions no verdict was asked about,
 * is held. An observation cites no guideline and keeps the floor.
 */
export function isPosted(finding: Finding, review: Review, context: PostingContext = {}): boolean {
  if (review.posting === "evidence" && finding.kind === "violation") {
    if (isHeldUnplaced(finding, review)) return false;
    const listed = context.guideline?.exclusions?.length ?? 0;
    return !(context.verdictsAsked === false && listed > 0);
  }
  return (finding.confidence ?? 1) >= review.confidenceFloor;
}

/** True for a violation held under evidence because its quote sits on no line; the report counts it apart from the floor. */
export function isHeldUnplaced(finding: Finding, review: Review): boolean {
  return review.posting === "evidence" && finding.kind === "violation" && finding.unplaced === true;
}

/** The option the prompt and the parser take under posting on evidence. */
export function evidenceFlag(review: Review): { evidence?: true } {
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
