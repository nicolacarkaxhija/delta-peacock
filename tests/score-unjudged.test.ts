import { describe, expect, it } from "vitest";
import { scoreFacts, scoreRun, type ReplayedFinding } from "../src/backtest/score.js";

const finding = (line: number): ReplayedFinding => ({
  file: "src/app.js",
  line,
  guidelineId: "no-console",
  severity: "MAJOR",
  title: "t",
  body: "b",
});

const EXPECTED = [{ file: "src/app.js", line: 5, guidelineId: "no-console" }];
const NO_FINDING = [{ file: "src/app.js", line: 2, guidelineId: "no-console", why: "marked" }];

describe("scoreRun", () => {
  it("leaves a finding outside every listed span unjudged when the case says so, and judges the listed spans as before", () => {
    const produced = [finding(2), finding(5), finding(9)];
    const score = scoreRun(produced, EXPECTED, NO_FINDING, 0, true);
    expect(score.right).toBe(1);
    expect(score.wrong.map((one) => [one.finding.line, one.reason])).toEqual([
      [2, "judged wrong before: marked"],
    ]);
    expect(score.unjudged).toEqual([finding(9)]);
    expect(score.found).toBe(2);
  });

  it("judges every finding without the marker", () => {
    const score = scoreRun([finding(9)], EXPECTED, NO_FINDING);
    expect(score.wrong.map((one) => one.reason)).toEqual(["not in the human judgement"]);
    expect(score.unjudged).toEqual([]);
    expect(score.found).toBe(1);
  });
});

describe("scoreFacts", () => {
  it("passes the marker on to the run score", () => {
    const score = scoreFacts(
      [finding(9)],
      [],
      NO_FINDING,
      { leftToPerson: [], notReviewed: [] },
      0,
      true,
    );
    expect(score.unjudged).toEqual([finding(9)]);
    expect(score.wrong).toEqual([]);
  });
});
