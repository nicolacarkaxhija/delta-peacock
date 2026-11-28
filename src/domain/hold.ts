import type { Finding } from "./finding.js";
import type { Guideline } from "./guideline.js";

/** Why a finding that survived every validator is not posted. */
export type HoldReason = "floor" | "unplaced" | "unchecked";

/** A reason other than the confidence floor; the report tags a finding held for one. */
export type TaggedHold = Exclude<HoldReason, "floor">;

/** Findings held per tagged reason; the rest of the held total sits under the floor. */
export type HoldCounts = Partial<Record<TaggedHold, number>>;

/** A held finding, tagged when held for a reason other than the floor. */
export type HeldFinding = Finding & { holdReason?: TaggedHold };

/** The posting settings a hold reads. */
export interface PostingRule {
  posting: "confidence" | "evidence";
  confidenceFloor: number;
}

/** What the caller knows about a finding beyond itself. */
export interface PostingContext {
  /** False where no exclusion verdict was asked, as in audit. */
  verdictsAsked?: boolean;
  guideline?: Pick<Guideline, "exclusions"> | undefined;
}

/**
 * Why a finding that survived every validator is held, or undefined when it is
 * posted. A violation whose quote could not be placed is held in every mode,
 * since a gate needs a line to act on. Under evidence a violation stands on
 * what was checked (a whole rule sentence at parse, its quote placed on a line
 * of the change, a cleared exclusion verdict), so a sampled confidence near the
 * floor cannot flip it between runs; one whose exclusions no verdict was asked
 * about is held. An observation cites no guideline and keeps the floor.
 */
export function holdReason(
  finding: Finding,
  review: PostingRule,
  context: PostingContext = {},
): HoldReason | undefined {
  if (finding.kind === "violation" && finding.unplaced === true) return "unplaced";
  if (review.posting === "evidence" && finding.kind === "violation") {
    const listed = context.guideline?.exclusions?.length ?? 0;
    return context.verdictsAsked === false && listed > 0 ? "unchecked" : undefined;
  }
  return (finding.confidence ?? 1) >= review.confidenceFloor ? undefined : "floor";
}

/** Whether a finding that survived every validator is posted. */
export function isPosted(
  finding: Finding,
  review: PostingRule,
  context: PostingContext = {},
): boolean {
  return holdReason(finding, review, context) === undefined;
}

/** How the log and the summary word a count per reason, in the order they list them. */
const HOLD_WORDING: Record<HoldReason, { log: string; noun: string; note?: string }> = {
  floor: { log: "finding(s) under the confidence floor", noun: "low-confidence finding" },
  unplaced: { log: "violation(s) held: not placed on a line", noun: "unplaced violation" },
  unchecked: {
    log: "violation(s) held: exclusion check skipped",
    noun: "unchecked violation",
    note: "exclusion check skipped",
  },
};

/** The held findings tagged with their reason other than the floor, and the count per such reason. */
export function tagHolds(
  held: readonly Finding[],
  reasonOf: (finding: Finding) => HoldReason | undefined,
): { findings: HeldFinding[]; counts: HoldCounts } {
  const counts: HoldCounts = {};
  const findings = held.map((finding): HeldFinding => {
    const reason = reasonOf(finding);
    if (reason === undefined || reason === "floor") return finding;
    counts[reason] = (counts[reason] ?? 0) + 1;
    return { ...finding, holdReason: reason };
  });
  return { findings, counts };
}

/** Each reason with findings held, its count and wording; the floor takes what the other reasons leave of the total. */
export function holdTally(
  total: number,
  counts: HoldCounts = {},
): { count: number; log: string; noun: string; note?: string }[] {
  const byReason: Record<HoldReason, number> = {
    floor: total - (counts.unplaced ?? 0) - (counts.unchecked ?? 0),
    unplaced: counts.unplaced ?? 0,
    unchecked: counts.unchecked ?? 0,
  };
  return (Object.keys(HOLD_WORDING) as HoldReason[])
    .filter((reason) => byReason[reason] > 0)
    .map((reason) => ({ count: byReason[reason], ...HOLD_WORDING[reason] }));
}
