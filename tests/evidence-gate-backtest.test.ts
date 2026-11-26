import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const CASE = "evidence-gate-with-exclusions";
/** The confidence a sampling model gave the same two candidates in three runs: around the floor. */
const CONFIDENCE_PER_REPEAT = [0.45, 0.55, 0.35];
const DEFAULT_LINE = '  return settings.get("lookbackDays") || 30;';

type Shapes = Record<string, Record<"default" | "amount", Partial<ModelReply>[]>>;

/** Replays the recorded review with the given confidence and the recorded verdict replies of one shape. */
function recordedModel(benchCase: BacktestCase, shape: string, confidence: number): ModelPort {
  const review = JSON.parse(readFileSync(path.join(benchCase.dir, "recorded.json"), "utf8")) as {
    findings: { confidence: number }[];
  };
  const text = JSON.stringify({
    findings: review.findings.map((finding) => ({ ...finding, confidence })),
  });
  const shapes = JSON.parse(
    readFileSync(path.join(benchCase.dir, "recorded-verdicts.json"), "utf8"),
  ) as Shapes;
  const asked = { default: 0, amount: 0 };
  return {
    complete(request) {
      const usage = { inputTokens: 100, outputTokens: 10 };
      if (!request.system.includes("exclusion check")) return Promise.resolve({ text, usage });
      const line = request.user.includes(`<line>\n${DEFAULT_LINE}\n</line>`) ? "default" : "amount";
      const replies = shapes[shape]?.[line] ?? [];
      const reply = replies[Math.min(asked[line], replies.length - 1)] ?? {};
      asked[line] += 1;
      return Promise.resolve({ text: "", usage, ...reply });
    },
  };
}

async function repeats(benchCase: BacktestCase, shape: string): Promise<Replay[]> {
  const runs: Replay[] = [];
  for (const confidence of CONFIDENCE_PER_REPEAT) {
    const work = mkdtempSync(path.join(tmpdir(), "bt-evidence-"));
    const modelPort = recordedModel(benchCase, shape, confidence);
    runs.push(await replayCase(testDeps(work, {}, { modelPort }), benchCase, work));
  }
  return runs;
}

describe("the evidence-gate-with-exclusions backtest case", () => {
  const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
  if (benchCase === undefined) throw new Error(`${CASE} is missing`);

  it("posts the amount and drops the default in all three repeats, whatever confidence the model gives, for each readable verdict shape", async () => {
    for (const shape of ["structured", "truncated, then fenced on the plain retry"]) {
      const runs = await repeats(benchCase, shape);
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
    const runs = await repeats(benchCase, "unreadable twice");
    for (const run of runs) {
      expect(run.findings).toEqual([]);
      expect(run.problems).toContain(
        "2 of 2 finding(s) got no readable exclusion verdict and were held",
      );
    }
    expect(drift(runs.map((run) => run.findings))).toBe(0);
  });

  it("drifts under posting: confidence, which posts the amount only in the repeat above the floor", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "bt-confidence-"));
    const copy = path.join(parent, CASE);
    cpSync(benchCase.dir, copy, { recursive: true });
    const config = path.join(copy, "base", "delta-peacock.config.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "  generalPass: false\n",
        "  generalPass: false\n  posting: confidence\n",
      ),
    );
    const [floored] = loadBacktestCases(parent, [CASE]);
    if (floored === undefined) throw new Error("copy is missing");
    const runs = await repeats(floored, "structured");
    expect(runs.map((run) => run.findings.map((finding) => finding.line))).toEqual([[], [8], []]);
    expect(drift(runs.map((run) => run.findings))).toBe(1);
  });
});
