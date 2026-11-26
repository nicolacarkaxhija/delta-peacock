import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { replayCase, type Replay } from "../src/backtest/replay.js";
import { drift, scoreRun } from "../src/backtest/score.js";
import type { ModelPort, ModelReply } from "../src/model/port.js";
import { testDeps } from "./helpers/deps.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "exclusion-verdict-shapes";
const REPEATS = 3;
const FALLBACK_LINE = '  return settings.get("retentionDays") || 30;';

type Shapes = Record<string, Record<"fallback" | "amount", Partial<ModelReply>[]>>;

/** The recorded review, and the recorded verdict replies of one shape. */
function recordedModel(benchCase: BacktestCase, shape: string): ModelPort {
  const review = readFileSync(path.join(benchCase.dir, "recorded.json"), "utf8");
  const shapes = JSON.parse(
    readFileSync(path.join(benchCase.dir, "recorded-verdicts.json"), "utf8"),
  ) as Shapes;
  const asked = { fallback: 0, amount: 0 };
  return {
    complete(request) {
      const usage = { inputTokens: 100, outputTokens: 10 };
      if (!request.system.includes("exclusion check")) {
        return Promise.resolve({ text: review, usage });
      }
      const line = request.user.includes(`<line>\n${FALLBACK_LINE}\n</line>`)
        ? "fallback"
        : "amount";
      const replies = shapes[shape]?.[line] ?? [];
      const reply = replies[Math.min(asked[line], replies.length - 1)] ?? {};
      asked[line] += 1;
      return Promise.resolve({ text: "", usage, ...reply });
    },
  };
}

async function replayRepeats(
  benchCase: BacktestCase,
  model: (repeat: number) => ModelPort,
): Promise<Replay[]> {
  const runs: Replay[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const work = mkdtempSync(path.join(tmpdir(), "bt-verdict-"));
    runs.push(await replayCase(testDeps(work, {}, { modelPort: model(repeat) }), benchCase, work));
  }
  return runs;
}

describe("the exclusion-verdict-shapes backtest case", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("keeps the amount and drops the fallback in all three repeats for each readable verdict shape", async () => {
    for (const shape of ["structured", "truncated, then fenced on the plain retry"]) {
      const runs = await replayRepeats(benchCase, () => recordedModel(benchCase, shape));
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
    const runs = await replayRepeats(benchCase, () => recordedModel(benchCase, "unreadable twice"));
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
