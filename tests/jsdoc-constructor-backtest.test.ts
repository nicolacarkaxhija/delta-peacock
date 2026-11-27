import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases } from "../src/backtest/cases.js";
import { replayCase } from "../src/backtest/replay.js";
import { scoreRun } from "../src/backtest/score.js";
import type { ModelPort } from "../src/model/port.js";
import { testDeps } from "./helpers/deps.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "jsdoc-constructor-returns-this";

// the syntax tree check decides the finding, so a model call is a failure
const noModel: ModelPort = {
  complete: () => Promise.reject(new Error("a syntax tree fact called a model")),
};

describe("a moved constructor whose doc comment changed only a namespace tag", () => {
  it("posts the missing @returns for return this as the one right finding, with no model call", async () => {
    const [benchCase] = loadBacktestCases(BACKTEST, [CASE]);
    if (benchCase === undefined) throw new Error(`${CASE} is missing`);
    const work = mkdtempSync(path.join(tmpdir(), "bt-constructor-"));
    const run = await replayCase(testDeps(work, {}, { modelPort: noModel }), benchCase, work);
    expect(run.error).toBeUndefined();
    expect(run.findings.map((finding) => finding.body)).toEqual([
      expect.stringContaining("returns a value its doc comment has no @returns for"),
    ]);
    const score = scoreRun(run.findings, benchCase.expected, benchCase.noFinding);
    expect(score).toMatchObject({ right: 1, wrong: [], missed: [] });
  });
});
