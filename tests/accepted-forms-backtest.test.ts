import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { replayCase } from "../src/backtest/replay.js";
import { scoreRun } from "../src/backtest/score.js";
import { loadConfig } from "../src/config/loader.js";
import type { ModelPort } from "../src/model/port.js";
import { buildPromptOptions } from "../src/review/prompt.js";
import type { ReviewReport } from "../src/review/report.js";
import { testDeps } from "./helpers/deps.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASES = ["axis-tags-locale-accepted", "axis-tags-not-site-accepted"];

// the response a model gave on these lines, replayed instead of a live call
function recorded(benchCase: BacktestCase): ModelPort {
  const text = readFileSync(path.join(benchCase.dir, "recorded.json"), "utf8");
  return {
    complete: () => Promise.resolve({ text, usage: { inputTokens: 1000, outputTokens: 100 } }),
  };
}

async function replay(benchCase: BacktestCase) {
  const work = mkdtempSync(path.join(tmpdir(), "bt-accepted-"));
  const run = await replayCase(
    testDeps(work, {}, { modelPort: recorded(benchCase) }),
    benchCase,
    work,
  );
  const report = JSON.parse(run.report ?? "{}") as ReviewReport;
  return { run, report };
}

describe("the accepted form backtest cases", () => {
  const cases = loadBacktestCases(BACKTEST, CASES);

  it("declare the site and locale tags they use in the prompt", () => {
    for (const one of cases) {
      const options = buildPromptOptions(loadConfig({ root: one.baseDir }), one.baseDir);
      expect(options.declarations).toContain("@not-site:BE");
      expect(options.declarations).toContain("@locale:nl");
    }
  });

  it("post nothing on the recorded false positive and count it as accepted", async () => {
    for (const one of cases) {
      const { run, report } = await replay(one);
      expect(run.error, one.name).toBeUndefined();
      expect(run.findings, one.name).toEqual([]);
      expect(scoreRun(run.findings, one.expected, one.noFinding).wrong).toEqual([]);
      expect(report.accepted?.map((finding) => finding.line)).toEqual([7]);
      expect(run.log).toContain(
        "1 finding(s) accepted: the repository lists their form as accepted",
      );
    }
  });

  it("post the recorded finding when the repository lists no accepted forms", async () => {
    for (const one of cases) {
      const parent = mkdtempSync(path.join(tmpdir(), "bt-unaccepted-"));
      cpSync(one.dir, path.join(parent, one.name), { recursive: true });
      rmSync(path.join(parent, one.name, "base", "guidelines", "accepted-forms.json"));
      const bare = loadBacktestCases(parent, [one.name])[0] ?? one;
      const { run, report } = await replay(bare);
      expect(
        run.findings.map((finding) => finding.line),
        one.name,
      ).toEqual([7]);
      expect(scoreRun(run.findings, one.expected, one.noFinding).wrong).toHaveLength(1);
      expect(report.accepted).toBeUndefined();
    }
  });
});
