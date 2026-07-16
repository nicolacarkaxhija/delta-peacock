import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases, runBench } from "../src/bench/harness.js";
import { overlapMatrix, scoreFindings } from "../src/bench/scoring.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { makeRepo } from "./helpers/git.js";

const CASES_DIR = fileURLToPath(new URL("../bench/cases", import.meta.url));

describe("scoring", () => {
  const expected = [{ file: "a.js", line: 10, guidelineId: "g" }];

  it.each([
    { name: "exact match", produced: [{ file: "a.js", line: 10, guidelineId: "g" }], f1: 1 },
    { name: "within tolerance", produced: [{ file: "a.js", line: 12, guidelineId: "g" }], f1: 1 },
    { name: "outside tolerance", produced: [{ file: "a.js", line: 15, guidelineId: "g" }], f1: 0 },
    { name: "wrong guideline", produced: [{ file: "a.js", line: 10, guidelineId: "x" }], f1: 0 },
    { name: "wrong file", produced: [{ file: "b.js", line: 10, guidelineId: "g" }], f1: 0 },
    { name: "nothing produced", produced: [], f1: 0 },
  ])("$name", ({ produced, f1 }) => {
    expect(scoreFindings(produced, expected).f1).toBeCloseTo(f1);
  });

  it("counts extras as false positives and computes the blend", () => {
    const result = scoreFindings(
      [
        { file: "a.js", line: 10, guidelineId: "g" },
        { file: "a.js", line: 40, guidelineId: "g" },
      ],
      expected,
    );
    expect(result).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0 });
    expect(result.precision).toBeCloseTo(0.5);
    expect(result.recall).toBeCloseTo(1);
  });

  it("matches a guideline-less expectation against any citation", () => {
    const result = scoreFindings(
      [{ file: "a.js", line: 10, guidelineId: "whatever" }],
      [{ file: "a.js", line: 10 }],
    );
    expect(result.f1).toBeCloseTo(1);
  });

  it("builds an overlap matrix without ground truth", () => {
    const matrix = overlapMatrix({
      base: [
        { file: "a.js", line: 1, guidelineId: "g" },
        { file: "b.js", line: 2, guidelineId: "g" },
      ],
      contextual: [{ file: "a.js", line: 1, guidelineId: "g" }],
    });
    expect(matrix["base"]?.["base"]).toBe(2);
    expect(matrix["base"]?.["contextual"]).toBe(1);
    expect(matrix["contextual"]?.["base"]).toBe(1);
  });
});

describe("harness", () => {
  it("loads the seed cases with diffs and expectations", () => {
    const cases = loadCases(CASES_DIR);
    expect(cases.map((benchCase) => benchCase.name)).toEqual([
      "01-single-file",
      "02-cross-file-signature",
    ]);
    expect(cases[0]?.expected).toHaveLength(1);
    expect(cases[1]?.diff).toContain("applyDiscount");
  });

  it("times cases and aggregates scores through an injected review function", async () => {
    const cases = loadCases(CASES_DIR);
    const outcome = await runBench(cases, (benchCase) =>
      Promise.resolve(benchCase.expected?.map((finding) => ({ ...finding })) ?? []),
    );
    expect(outcome.cases).toHaveLength(2);
    expect(outcome.cases.every((c) => c.milliseconds >= 0)).toBe(true);
    expect(outcome.aggregate?.f1).toBeCloseTo(1);
  });

  it("throws a tool error for an empty or missing cases directory", () => {
    expect(() => loadCases("definitely-missing")).toThrow("not found");
  });
});

describe("bench command discriminates context strategies", () => {
  /** Reports the breaking change only when the prompt shows it the caller. */
  const contextSensitiveModel: ModelPort = {
    complete(request) {
      const findings = [];
      if (request.user.includes("console.log")) {
        findings.push({
          guidelineId: "no-console",
          file: "src/app.js",
          line: 2,
          title: "Console call",
          body: "b",
        });
      }
      if (request.system.includes("checkout.js")) {
        findings.push({
          guidelineId: "no-breaking-signature-change",
          file: "src/pricing.js",
          line: 1,
          title: "Signature change breaks checkout.js",
          body: "b",
        });
      }
      return Promise.resolve({ text: JSON.stringify({ findings }) });
    },
  };

  async function bench(context: string): Promise<{ code: number; stdout: string }> {
    let stdout = "";
    const code = await runCli(["bench", "--cases", CASES_DIR, "--context", context], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: contextSensitiveModel,
    });
    return { code, stdout };
  }

  it("scores zero on the cross-file case without context", async () => {
    const { code, stdout } = await bench("none");
    expect(code).toBe(0);
    const crossFileRow = stdout.split("\n").find((line) => line.includes("02-cross-file"));
    expect(crossFileRow).toContain("0%");
    expect(stdout).toContain("| aggregate |");
  });

  it("scores the cross-file case once the repo map shows the caller", async () => {
    const { code, stdout } = await bench("repo_map");
    expect(code).toBe(0);
    const crossFileRow = stdout.split("\n").find((line) => line.includes("02-cross-file"));
    expect(crossFileRow).toContain("100%");
  });
});
