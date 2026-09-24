import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases, runBench } from "../src/bench/harness.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "../src/guidelines/loader.js";
import { overlapMatrix, scoreFindings } from "../src/bench/scoring.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
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
    // the corpus has grown with SFRA-style storefront cases alongside the two
    // seed cases this test was written against; only the seed cases' own
    // shape is this test's concern, not the corpus's final size
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
    // the toy model only answers the two seed cases; scope this run to just
    // those two so the corpus's storefront cases (which it cannot
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

describe("bench wires context tools like a real review does", () => {
  function capture(): { requests: ModelRequest[]; port: ModelPort } {
    const requests: ModelRequest[] = [];
    return {
      requests,
      port: {
        complete(request) {
          requests.push(request);
          return Promise.resolve({ text: '{"findings": []}' });
        },
      },
    };
  }

  it("attaches the agentic provider's tools and maxToolRounds, so the model can read case files", async () => {
    const { requests, port } = capture();
    const code = await runCli(["bench", "--cases", CASES_DIR, "--context", "agentic"], {
      cwd: makeRepo(),
      env: { DELTA_PEACOCK_CONTEXT_MAX_TOOL_ROUNDS: "3" },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    // only cases with a files/ directory give the agentic provider anything
    // to scan; several of the seeded cases do
    const withTools = requests.find((request) => request.tools !== undefined);
    expect(withTools).toBeDefined();
    expect(Object.keys(withTools?.tools ?? {})).toEqual([
      "get_definition",
      "find_references",
      "read_file_range",
      "search",
    ]);
    expect(withTools?.maxToolRounds).toBe(3);
  });

  it("attaches no tools for --context none", async () => {
    const { requests, port } = capture();
    const code = await runCli(["bench", "--cases", CASES_DIR, "--context", "none"], {
      cwd: makeRepo(),
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.tools === undefined)).toBe(true);
  });
});

describe("bench survives a case whose model reply crashes", () => {
  // observed twice against the real corpus: one case's reply held no
  // parseable JSON, and the ToolError out of parseReviewResponse aborted the
  // whole run -- discarding the other cases' scores and printing no table at
  // all. Scope to the two seed cases so this test's call-order assumption
  // (01 before 02) never drifts as more cases are added elsewhere.
  async function seedCasesDir(): Promise<string> {
    const { mkdtempSync, cpSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-bench-crash-"));
    for (const name of ["01-single-file", "02-cross-file-signature"]) {
      cpSync(path.join(CASES_DIR, name), path.join(dir, name), { recursive: true });
    }
    return dir;
  }

  /** The first case's reply is unparseable prose-free JSON garbage; the second answers cleanly. */
  function flakyPort(): ModelPort {
    let calls = 0;
    return {
      complete: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ text: "{ not json }" });
        return Promise.resolve({
          text: JSON.stringify({
            findings: [
              {
                guidelineId: "no-breaking-signature-change",
                file: "src/pricing.js",
                line: 1,
                title: "Signature change breaks checkout.js",
                body: "b",
              },
            ],
          }),
        });
      },
    };
  }

  it("keeps the other case's score and marks the crashed one instead of aborting the run", async () => {
    const seedCases = await seedCasesDir();
    let stdout = "";
    const code = await runCli(["bench", "--cases", seedCases, "--context", "none"], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: flakyPort(),
    });

    expect(code).toBe(0); // one crashed case must not abort an otherwise-scorable run
    const rows = stdout.split("\n");
    const crashedRow = rows.find((line) => line.includes("01-single-file"));
    const okRow = rows.find((line) => line.includes("02-cross-file-signature"));
    expect(okRow).toContain("100%"); // the other case's score survives untouched
    // the crashed case must read as crashed, never as a genuine clean pass
    expect(crashedRow?.toLowerCase()).toContain("error");
    const aggregateRow = rows.find((line) => line.startsWith("| aggregate"));
    expect(aggregateRow).toBeDefined();
    expect(aggregateRow?.toLowerCase()).toContain("errored");
  });

  it("still fails the run when every case's reply is unparseable", async () => {
    const seedCases = await seedCasesDir();
    const allBroken: ModelPort = { complete: () => Promise.resolve({ text: "{ not json }" }) };
    let stdout = "";
    let stderr = "";
    const code = await runCli(["bench", "--cases", seedCases, "--context", "none"], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      modelPort: allBroken,
    });
    expect(code).toBe(1); // every case crashing is a genuine failure, not a clean pass
    expect(stderr).toContain("every case");
    expect(stdout).not.toContain("| aggregate |"); // no partial table on total failure
  });
});

describe("bench applies the structural verifier like a real review does", () => {
  const BADGES =
    "cartridges/int_meadow_badges/cartridge/scripts/models/decorators/badgeDecorators.js";
  const PRODUCT = "cartridges/app_meadow_storefront/cartridge/controllers/Product.js";

  function replying(findings: object[]): ModelPort {
    return { complete: () => Promise.resolve({ text: JSON.stringify({ findings }) }) };
  }

  async function benchRows(casesDir: string, port: ModelPort): Promise<string[]> {
    let stdout = "";
    const code = await runCli(["bench", "--cases", casesDir, "--context", "none"], {
      cwd: makeRepo(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    return stdout.split("\n");
  }

  it("declares a structural check on every corpus guideline shaped like one", () => {
    const expected: Record<string, string> = {
      "05-sfra-const-in-loop-tn-callback": "no-declaration-in-loop",
      "06-sfra-top-require-tn-deferred": "module-scope-only",
      "08-sfra-const-in-loop-tn-process-callback": "no-declaration-in-loop",
    };
    for (const [name, check] of Object.entries(expected)) {
      const { guidelines } = loadGuidelinesFromFiles(
        readWorkingTreeGuidelines(path.join(CASES_DIR, name, "guidelines")),
      );
      expect(guidelines.map((guideline) => guideline.structural)).toEqual([check]);
    }
  });

  it("drops corpus false positives the AST contradicts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-bench-structural-"));
    for (const name of ["05-sfra-const-in-loop-tn-callback", "06-sfra-top-require-tn-deferred"]) {
      cpSync(path.join(CASES_DIR, name), path.join(dir, name), { recursive: true });
    }
    // const in a forEach callback, and a require already deferred into a route
    const rows = await benchRows(
      dir,
      replying([
        { guidelineId: "SFRA-NO-CONST-IN-LOOP", file: BADGES, line: 87, title: "t", body: "b" },
        { guidelineId: "SFRA-NO-TOP-REQUIRE", file: PRODUCT, line: 36, title: "t", body: "b" },
      ]),
    );
    expect(rows.find((line) => line.includes("05-sfra"))).toContain("| 0 |");
    expect(rows.find((line) => line.includes("06-sfra"))).toContain("| 0 |");
  });

  it("keeps a finding the AST confirms", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-bench-structural-"));
    const caseDir = path.join(dir, "loop");
    mkdirSync(path.join(caseDir, "guidelines"), { recursive: true });
    mkdirSync(path.join(caseDir, "files", "src"), { recursive: true });
    writeFileSync(
      path.join(caseDir, "guidelines", "rule.md"),
      "---\nid: no-const-in-loop\nseverity: BLOCKER\nstructural: no-declaration-in-loop\n---\nbody\n",
    );
    const source = [
      "function f(items) {",
      "  for (var i = 0; i < items.length; i++) {",
      "    const total = items[i];",
      "  }",
      "  items.forEach(function (item) {",
      "    const id = item;",
      "  });",
      "}",
    ];
    writeFileSync(path.join(caseDir, "files", "src", "app.js"), `${source.join("\n")}\n`);
    writeFileSync(
      path.join(caseDir, "diff.patch"),
      [
        "diff --git a/src/app.js b/src/app.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/app.js",
        `@@ -0,0 +1,${String(source.length)} @@`,
        ...source.map((line) => `+${line}`),
        "",
      ].join("\n"),
    );
    const rows = await benchRows(
      dir,
      replying([
        { guidelineId: "no-const-in-loop", file: "src/app.js", line: 3, title: "t", body: "b" },
        { guidelineId: "no-const-in-loop", file: "src/app.js", line: 6, title: "t", body: "b" },
      ]),
    );
    expect(rows.find((line) => line.startsWith("| loop |"))).toContain("| 1 |");
  });
});
