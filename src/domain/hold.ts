import type { Finding } from "./finding.js";

/** Why a finding that survived every validator is not posted. */
export type HoldReason = "floor" | "unplaced" | "unchecked";

/** A reason only posting: evidence gives; the report tags a finding held for one. */
export type EvidenceHold = Exclude<HoldReason, "floor">;

/** Findings held per evidence reason; the rest of the held total sits under the floor. */
export type HoldCounts = Partial<Record<EvidenceHold, number>>;

/** A held finding, tagged when held for a reason other than the floor. */
export type HeldFinding = Finding & { holdReason?: EvidenceHold };

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

/** The held findings tagged with their evidence reason, and the count per such reason. */
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

/** Each reason with findings held, its count and wording; the floor takes what the evidence reasons leave of the total. */
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
