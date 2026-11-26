import type { Config } from "../config/schema.js";
import type { Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";

type Review = Pick<Config["review"], "posting" | "confidenceFloor">;

/** What the caller knows about a finding beyond itself. */
export interface PostingContext {
  /** False where no exclusion verdict was asked, as in audit. */
  verdictsAsked?: boolean;
  guideline?: Pick<Guideline, "exclusions">;
}

/** Whether a finding that survived every validator is posted. */
export function isPosted(finding: Finding, review: Review, context: PostingContext = {}): boolean {
  void context;
  return (finding.confidence ?? 1) >= review.confidenceFloor;
}

/** The option the prompt and the parser take under posting on evidence. */
export function evidenceFlag(review: Review): { evidence?: true } {
  void review;
  return {};
}

/** The posting context of each finding: a model finding whose exclusion check was skipped, and that no check found too, asked no verdict. */
export function skippedCheckContext(
  skipped: readonly Finding[],
  fromChecks: readonly Finding[],
  guidelinesById: ReadonlyMap<string, Pick<Guideline, "exclusions">>,
): (finding: Finding) => PostingContext {
  void skipped;
  void fromChecks;
  void guidelinesById;
  return () => ({});
}
