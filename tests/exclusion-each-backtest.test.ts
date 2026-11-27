import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { scoreRun } from "../src/backtest/score.js";
import type { ModelPort, ModelReply } from "../src/model/port.js";
import { replayRepeats } from "./helpers/verdict-replay.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "exclusion-verdict-each-sentence";
const STAMP_LINE = "  const stamp = order.placed.toISOString();";
const REPEATS = 2;

type Recorded = Record<"pick" | "each", Record<"shown" | "stamp", Partial<ModelReply>[]>>;

/** The case's recorded review, and its recorded verdict for the form each request asks in. */
function recordedModel(benchCase: BacktestCase): ModelPort {
  const review = readFileSync(path.join(benchCase.dir, "recorded.json"), "utf8");
  const verdicts = JSON.parse(
    readFileSync(path.join(benchCase.dir, "recorded-verdicts.json"), "utf8"),
  ) as Recorded;
  return {
    complete(request) {
      const usage = { inputTokens: 100, outputTokens: 10 };
      if (!request.system.includes("exclusion check")) {
        return Promise.resolve({ text: review, usage });
      }
      const form = request.system.includes('"sentences"') ? "each" : "pick";
      const line = request.user.includes(`<line>\n${STAMP_LINE}\n</line>`) ? "stamp" : "shown";
      return Promise.resolve({ text: "", usage, ...verdicts[form][line][0] });
    },
  };
}

/** The case with exclusions.verdict set to pick, in a folder of its own. */
function withPick(benchCase: BacktestCase): BacktestCase {
  const parent = mkdtempSync(path.join(tmpdir(), "bt-pick-"));
  const copy = path.join(parent, CASE);
  cpSync(benchCase.dir, copy, { recursive: true });
  const config = path.join(copy, "base", "delta-peacock.config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("verdict: each", "verdict: pick"));
  const [changed] = loadBacktestCases(parent, [CASE]);
  if (changed === undefined) throw new Error("copy is missing");
  return changed;
}

const scores = async (benchCase: BacktestCase) =>
  (await replayRepeats(benchCase, REPEATS, () => recordedModel(benchCase))).map((run) => {
    const score = scoreRun(run.findings, benchCase.expected, benchCase.noFinding);
    return {
      error: run.error,
      problems: run.problems,
      wrong: score.wrong.map((one) => one.finding.line),
      missed: score.missed.length,
    };
  });

describe("the exclusion-verdict-each-sentence backtest case", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("posts the hand joined date and drops the machine timestamp in every replay when each sentence gets its own answer", async () => {
    const clean = { error: undefined, problems: [], wrong: [], missed: 0 };
    expect(await scores(benchCase)).toEqual([clean, clean]);
  });

  it("posts the machine timestamp as a wrong finding when the recorded pick verdict answers none", async () => {
    const leaked = { error: undefined, problems: [], wrong: [5], missed: 0 };
    expect(await scores(withPick(benchCase))).toEqual([leaked, leaked]);
  });
});
