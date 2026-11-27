import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { drift } from "../src/backtest/score.js";
import { recordedModel, replayRepeats } from "./helpers/verdict-replay.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "exclusion-verdict-shapes";
/** The confidence a sampling model gave the same two candidates in three runs: around the floor. */
const CONFIDENCE_PER_REPEAT = [0.45, 0.55, 0.35];

/** The case with review.posting set, in a folder of its own. */
function withPosting(benchCase: BacktestCase, posting: string): BacktestCase {
  const parent = mkdtempSync(path.join(tmpdir(), "bt-posting-"));
  const copy = path.join(parent, CASE);
  cpSync(benchCase.dir, copy, { recursive: true });
  const config = path.join(copy, "base", "delta-peacock.config.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "  generalPass: false\n",
      `  generalPass: false\n  posting: ${posting}\n`,
    ),
  );
  const [changed] = loadBacktestCases(parent, [CASE]);
  if (changed === undefined) throw new Error("copy is missing");
  return changed;
}

const linesOf = (benchCase: BacktestCase) =>
  replayRepeats(benchCase, CONFIDENCE_PER_REPEAT.length, (repeat) =>
    recordedModel(benchCase, "structured", CONFIDENCE_PER_REPEAT[repeat]),
  ).then((runs) => ({
    lines: runs.map((run) => run.findings.map((finding) => finding.line)),
    drift: drift(runs.map((run) => run.findings)),
  }));

describe("posting on evidence over three replays whose confidence moves around the floor", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("posts the amount in every replay under posting: evidence", async () => {
    expect(await linesOf(withPosting(benchCase, "evidence"))).toEqual({
      lines: [[8], [8], [8]],
      drift: 0,
    });
  });

  it("posts it only in the replay above the floor under the default posting: confidence", async () => {
    expect(await linesOf(benchCase)).toEqual({ lines: [[], [8], []], drift: 1 });
  });
});
