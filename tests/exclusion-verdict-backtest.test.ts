import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases } from "../src/backtest/cases.js";
import { drift, scoreRun } from "../src/backtest/score.js";
import { recordedModel, replayRepeats } from "./helpers/verdict-replay.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "exclusion-verdict-shapes";
const REPEATS = 3;
describe("the exclusion-verdict-shapes backtest case", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("keeps the amount and drops the fallback in all three repeats for each readable verdict shape", async () => {
    for (const shape of ["structured", "truncated, then fenced on the plain retry"]) {
      const runs = await replayRepeats(benchCase, REPEATS, () => recordedModel(benchCase, shape));
      for (const run of runs) {
        const score = scoreRun(run.findings, benchCase.expected, benchCase.noFinding);
        expect(run.error, shape).toBeUndefined();
        expect(score.wrong, shape).toEqual([]);
        expect(score.missed, shape).toEqual([]);
        expect(run.problems, shape).toEqual([]);
      }
      expect(drift(runs.map((run) => run.findings)), shape).toBe(0);
    }
  });

  it("holds both findings in all three repeats when no verdict is readable, and lists the problem", async () => {
    const runs = await replayRepeats(benchCase, REPEATS, () =>
      recordedModel(benchCase, "unreadable twice"),
    );
    for (const run of runs) {
      expect(run.findings).toEqual([]);
      expect(run.problems).toContain(
        "2 of 2 finding(s) got no readable exclusion verdict and were held",
      );
      expect(run.log).toContain("this review is incomplete");
    }
    expect(drift(runs.map((run) => run.findings))).toBe(0);
  });
});
