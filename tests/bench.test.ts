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

  it("scores zero recall against an empty expectation set", () => {
    const result = scoreFindings([{ file: "a.js", line: 1, guidelineId: "g" }], []);
    expect(result.recall).toBe(0);
    expect(result.falsePositives).toBe(1);
  });

  it("keeps empty variants in the overlap matrix", () => {
    const matrix = overlapMatrix({
      something: [{ file: "a.js", line: 1, guidelineId: "g" }],
      nothing: [],
    });
    expect(matrix["nothing"]?.["something"]).toBe(0);
    expect(matrix["something"]?.["nothing"]).toBe(0);
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
    // the corpus has grown with L360-grounded cases alongside the two
    // synthetic seed cases this test was written against; only the seed
    // cases' own shape is this test's concern, not the corpus's final size
    expect(cases.length).toBeGreaterThanOrEqual(2);
    expect(cases.slice(0, 2).map((benchCase) => benchCase.name)).toEqual([
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
    expect(outcome.cases).toHaveLength(cases.length);
    expect(outcome.cases.every((c) => c.milliseconds >= 0)).toBe(true);
    expect(outcome.aggregate?.f1).toBeCloseTo(1);
  });

  it("throws a tool error for an empty or missing cases directory", () => {
    expect(() => loadCases("definitely-missing")).toThrow("not found");
  });

  it("skips stray files and caseless directories, and reports an empty result", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-bench-"));
    writeFileSync(path.join(dir, "notes.txt"), "not a case");
    mkdirSync(path.join(dir, "no-diff-here"));
    expect(() => loadCases(dir)).toThrow("no cases found");
  });

  it("renders unscored cases with dashes and no aggregate", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { formatTable } = await import("../src/bench/harness.js");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-bench-"));
    mkdirSync(path.join(dir, "unscored"));
    writeFileSync(path.join(dir, "unscored", "diff.patch"), "diff --git a/x b/x\n+x\n");
    const outcome = await runBench(loadCases(dir), () => Promise.resolve([]));
    const table = formatTable(outcome);
    expect(table).toContain("| unscored | 0 | - | - | - |");
    expect(table).not.toContain("aggregate");
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

  it("carries general-pass observations as guideline-less findings", async () => {
    const repo = makeRepo();
    let stdout = "";
    const observing: ModelPort = {
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({
            findings: [{ file: "src/app.js", line: 2, title: "obs", body: "b", severity: "MINOR" }],
          }),
        }),
    };
    const code = await runCli(["bench", "--cases", CASES_DIR, "--context", "none"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_GENERAL_PASS: "true" },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: observing,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("| 01-single-file | 1 |");
  });

  it("a single-entry contexts list behaves like a plain run", async () => {
    let stdout = "";
    const code = await runCli(["bench", "--cases", CASES_DIR, "--contexts", "none"], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: contextSensitiveModel,
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain("overlap matrix");
  });

  it("passes the min-f1 gate when the corpus scores above the threshold", async () => {
    // the toy model only answers the two synthetic seed cases; scope this
    // run to just those two so the corpus's L360 cases (which it cannot
    // answer) do not drag the aggregate below the gate's threshold
    const { mkdtempSync, cpSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const seedCases = mkdtempSync(path.join(tmpdir(), "peacock-bench-seed-"));
    for (const name of ["01-single-file", "02-cross-file-signature"]) {
      cpSync(path.join(CASES_DIR, name), path.join(seedCases, name), { recursive: true });
    }

    let err = "";
    const code = await runCli(
      ["bench", "--cases", seedCases, "--context", "repo_map", "--min-f1", "0.9"],
      {
        cwd: makeRepo(),
        env: {},
        out: () => undefined,
        err: (text) => {
          err += text;
        },
        modelPort: contextSensitiveModel,
      },
    );
    expect(code).toBe(0);
    expect(err).not.toContain("below the --min-f1");
  });

  it("fails the min-f1 gate when the corpus regresses", async () => {
    const silent: ModelPort = { complete: () => Promise.resolve({ text: '{"findings": []}' }) };
    let err = "";
    const code = await runCli(
      ["bench", "--cases", CASES_DIR, "--context", "none", "--min-f1", "0.5"],
      {
        cwd: makeRepo(),
        env: {},
        out: () => undefined,
        err: (text) => {
          err += text;
        },
        modelPort: silent,
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("below the --min-f1 threshold");
  });

  it("writes the outcome json when asked", async () => {
    const repo = makeRepo();
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const code = await runCli(
      ["bench", "--cases", CASES_DIR, "--context", "none", "--report", "bench.json"],
      {
        cwd: repo,
        env: {},
        out: () => undefined,
        err: () => undefined,
        modelPort: contextSensitiveModel,
      },
    );
    expect(code).toBe(0);
    const outcome = JSON.parse(readFileSync(path.join(repo, "bench.json"), "utf8")) as {
      cases: unknown[];
      aggregate?: unknown;
    };
    expect(outcome.cases).toHaveLength(loadCases(CASES_DIR).length);
    expect(outcome.aggregate).toBeDefined();
  });
});
