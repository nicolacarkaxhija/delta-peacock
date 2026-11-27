import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import { holdTally, tagHolds, type HoldCounts, type HoldReason } from "../src/domain/hold.js";
import { renderReview } from "../src/review/render.js";
import { renderSummaryBody } from "../src/scm/comment-format.js";

const finding = (title: string): Finding => ({
  kind: "violation",
  guidelineId: "guard-before-use",
  severity: "MAJOR",
  file: "src/app.js",
  line: 2,
  title,
  body: "Guard it.",
});

const PASSED = { threshold: "MAJOR" as const, failing: 0, failed: false };

describe("tagHolds", () => {
  it("tags a finding held for an evidence reason, counts it, and leaves a floor finding as it was", () => {
    const reasons: Record<string, HoldReason | undefined> = {
      low: "floor",
      lost: "unplaced",
      skipped: "unchecked",
      again: "unchecked",
      none: undefined,
    };
    const held = Object.keys(reasons).map(finding);
    const { findings, counts } = tagHolds(held, (one) => reasons[one.title]);
    expect(findings.map((one) => [one.title, one.holdReason])).toEqual([
      ["low", undefined],
      ["lost", "unplaced"],
      ["skipped", "unchecked"],
      ["again", "unchecked"],
      ["none", undefined],
    ]);
    expect(findings[0]).toBe(held[0]);
    expect(counts).toEqual({ unplaced: 1, unchecked: 2 });
  });
});

describe("holdTally", () => {
  it.each<[number, HoldCounts | undefined, [number, string][]]>([
    [0, undefined, []],
    [2, undefined, [[2, "finding(s) under the confidence floor"]]],
    [1, { unchecked: 1 }, [[1, "violation(s) held: exclusion check skipped"]]],
    [
      4,
      { unplaced: 1, unchecked: 2 },
      [
        [1, "finding(s) under the confidence floor"],
        [1, "violation(s) held: not placed on a line"],
        [2, "violation(s) held: exclusion check skipped"],
      ],
    ],
  ])(
    "lists %i held with %j under each reason that holds any, summing to the total",
    (total, counts, rows) => {
      const tally = holdTally(total, counts);
      expect(tally.map((hold) => [hold.count, hold.log])).toEqual(rows);
      expect(tally.reduce((sum, hold) => sum + hold.count, 0)).toBe(total);
    },
  );
});

describe("held counts in the log and the summary", () => {
  it.each<[HoldCounts | undefined, number, string, string]>([
    [
      undefined,
      2,
      "2 finding(s) under the confidence floor (report only)\n",
      "_Not posted: 2 low-confidence findings._",
    ],
    [
      { unplaced: 1, unchecked: 2 },
      4,
      "1 finding(s) under the confidence floor (report only)\n1 violation(s) held: not placed on a line (report only)\n2 violation(s) held: exclusion check skipped (report only)\n",
      "_Not posted: 1 low-confidence finding, 1 unplaced violation, 2 unchecked violations (exclusion check skipped)._",
    ],
  ])("words the holds %j of %i held per reason", (holds, filtered, log, summary) => {
    const counts = holds === undefined ? {} : { holds };
    const out = renderReview({
      violations: [],
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      filtered,
      ...counts,
      gate: PASSED,
    });
    expect(out).toContain(log);
    const body = renderSummaryBody({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered,
      ...counts,
      gate: PASSED,
    });
    expect(body).toContain(summary);
  });
});
