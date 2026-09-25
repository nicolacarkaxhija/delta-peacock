import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runBench } from "../src/bench/harness.js";
import { scoreFindings } from "../src/bench/scoring.js";
import { guidelinesDirFor } from "../src/commands/bench.js";
import { loadGuidelinesFromFiles } from "../src/guidelines/loader.js";
import { parseReviewResponse } from "../src/review/parse.js";
import { runCli } from "../src/index.js";
import type { ModelRef } from "../src/model/build.js";
import type { ModelPort, ModelReply } from "../src/model/port.js";

const GUIDELINE =
  "---\nid: natural-comments\nseverity: MINOR\npaths: ['pages/**']\n---\n# Comments are one short natural line\n\nA comment says what the code cannot: a reason.\n";

/** A corpus with one case and the shared bench/guidelines folder beside cases/. */
function corpus(): { root: string; cases: string } {
  const root = mkdtempSync(path.join(tmpdir(), "dp-bench-018-"));
  const cases = path.join(root, "bench", "cases");
  const dir = path.join(cases, "01-two-line");
  mkdirSync(path.join(dir, "files", "pages"), { recursive: true });
  mkdirSync(path.join(root, "bench", "guidelines"), { recursive: true });
  writeFileSync(path.join(root, "bench", "guidelines", "natural-comments.md"), GUIDELINE);
  const source =
    "// The panel has no test id,\n// and its class is the same in every language.\nconst panel = '.p';\n";
  writeFileSync(path.join(dir, "files", "pages", "home.ts"), source);
  writeFileSync(
    path.join(dir, "diff.patch"),
    [
      "diff --git a/pages/home.ts b/pages/home.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pages/home.ts",
      "@@ -0,0 +1,3 @@",
      ...source
        .trimEnd()
        .split("\n")
        .map((line) => `+${line}`),
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "expected.json"),
    JSON.stringify({
      findings: [
        {
          file: "pages/home.ts",
          line: 1,
          guidelineId: "natural-comments",
          suggestionIncludes: ["every language"],
        },
      ],
    }),
  );
  return { root, cases };
}

const finding = (suggestion: string, guidelineQuote = "A comment says what the code cannot") => ({
  guidelineId: "natural-comments",
  file: "pages/home.ts",
  line: 1,
  quote: "// The panel has no test id,",
  guidelineQuote,
  title: "Two line comment",
  body: "Keep it on one line.",
  suggestion,
});

const reply = (findings: unknown[], inputTokens = 100): ModelReply => ({
  text: JSON.stringify({ findings }),
  usage: { inputTokens, outputTokens: 10 },
});

async function bench(
  env: Record<string, string>,
  ports: { modelPort?: ModelPort; modelPortFor?: (ref: ModelRef) => ModelPort },
): Promise<Record<string, unknown>> {
  const { root, cases } = corpus();
  const report = path.join(root, "report.json");
  const code = await runCli(["bench", "--cases", cases, "--report", report], {
    cwd: root,
    env: { DELTA_PEACOCK_MODEL_ID: "haiku", ...env },
    out: () => undefined,
    err: () => undefined,
    ...ports,
  });
  expect(code).toBe(0);
  return JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
}

interface Outcome {
  cases: {
    usage?: Record<string, { inputTokens: number }>;
    misquoted?: number;
    produced: { suggestion?: string; calibration?: string }[];
  }[];
  aggregate: { f1: number };
}

describe("bench 0.1.8", () => {
  it("falls back to the corpus guidelines and scores the suggestion text", async () => {
    const good = (await bench(
      {},
      {
        modelPort: {
          complete: () =>
            Promise.resolve(
              reply([finding("// No test id; the class is the same in every language.")]),
            ),
        },
      },
    )) as unknown as Outcome;
    expect(good.aggregate.f1).toBe(1);
    expect(good.cases[0]?.usage?.["haiku"]?.inputTokens).toBe(100);
    const lossy = (await bench(
      {},
      {
        modelPort: {
          complete: () => Promise.resolve(reply([finding("// The panel has no test id.")])),
        },
      },
    )) as unknown as Outcome;
    expect(lossy.aggregate.f1).toBe(0);
  });

  it("drops and counts a finding that quotes a rule the guideline lacks", async () => {
    const outcome = (await bench(
      {},
      {
        modelPort: {
          complete: () => Promise.resolve(reply([finding("x", "comments never use semicolons")])),
        },
      },
    )) as unknown as Outcome;
    expect(outcome.cases[0]?.produced).toHaveLength(0);
    expect(outcome.cases[0]?.misquoted).toBe(1);
  });

  it("retries an unreadable reply once, as a live review does", async () => {
    let calls = 0;
    const outcome = (await bench(
      {},
      {
        modelPort: {
          complete: () => {
            calls += 1;
            return Promise.resolve(
              calls === 1
                ? { text: "no json here", usage: { inputTokens: 5, outputTokens: 1 } }
                : reply([finding("// No test id; the class is the same in every language.")]),
            );
          },
        },
      },
    )) as unknown as Outcome;
    expect(calls).toBe(2);
    expect(outcome.aggregate.f1).toBe(1);
    expect(outcome.cases[0]?.usage?.["haiku"]?.inputTokens).toBe(105);
  });

  it("runs the ensemble and calibration, pricing tokens per model", async () => {
    const byId: Record<string, ModelPort> = {
      a: {
        complete: () =>
          Promise.resolve(
            reply([finding("// No test id; the class is the same in every language.")], 10),
          ),
      },
      b: { complete: () => Promise.resolve(reply([], 20)) },
      cal: {
        complete: (request) => {
          const fingerprint = /"fingerprint": "([0-9a-f]+)"/.exec(request.user)?.[1] ?? "";
          return Promise.resolve({
            text: JSON.stringify({ decisions: [{ fingerprint, action: "drop", reason: "noise" }] }),
            usage: { inputTokens: 7, outputTokens: 1 },
          });
        },
      },
    };
    const outcome = (await bench(
      {
        DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
        DELTA_PEACOCK_ENSEMBLE_MEMBERS: JSON.stringify([
          { provider: "bedrock", id: "a" },
          { provider: "bedrock", id: "b" },
        ]),
        DELTA_PEACOCK_CALIBRATION_ENABLED: "true",
        DELTA_PEACOCK_CALIBRATION_MODEL: JSON.stringify({ provider: "bedrock", id: "cal" }),
      },
      {
        modelPortFor: (ref) => {
          const port = byId[ref.id];
          if (port === undefined) throw new Error(`no fake for ${ref.id}`);
          return port;
        },
      },
    )) as unknown as Outcome;
    const usage = outcome.cases[0]?.usage ?? {};
    expect(Object.keys(usage).sort()).toEqual(["a", "b", "cal"]);
    expect(outcome.cases[0]?.produced[0]?.calibration).toBe("drop");
    expect(outcome.aggregate.f1).toBe(1);
  });

  it("prefers a case's own guidelines folder", () => {
    const { cases } = corpus();
    const own = path.join(cases, "01-two-line");
    expect(guidelinesDirFor(own)).toBe(path.join(cases, "..", "guidelines"));
    mkdirSync(path.join(own, "guidelines"));
    expect(guidelinesDirFor(own)).toBe(path.join(own, "guidelines"));
  });

  it("accepts plain finding arrays and results with extras from a review function", async () => {
    const outcome = await runBench(
      [
        { name: "x", dir: "x", diff: "", expected: [] },
        { name: "y", dir: "y", diff: "" },
      ],
      (benchCase) =>
        Promise.resolve(
          benchCase.name === "x"
            ? []
            : { produced: [], misquoted: 0, usage: { m: { inputTokens: 1, outputTokens: 1 } } },
        ),
    );
    expect(outcome.cases[1]?.usage).toBeDefined();
    expect(outcome.cases[1]?.misquoted).toBeUndefined();
  });

  it("reads null optional fields in a reply as absent, not malformed", () => {
    const guideline = loadGuidelinesFromFiles(
      [{ displayPath: "g.md", content: GUIDELINE }],
      "lenient",
    ).guidelines[0];
    const parsed = parseReviewResponse(
      JSON.stringify({
        findings: [
          {
            ...finding("x"),
            suggestion: null,
            confidence: null,
            title: null,
            body: null,
            severity: null,
            proposedGuideline: null,
          },
        ],
      }),
      {
        guidelinesById: new Map(guideline ? [[guideline.id, guideline]] : []),
        generalPass: false,
        observationSeverityCap: "MINOR",
      },
    );
    expect(parsed.droppedMalformed).toBe(0);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.suggestion).toBeUndefined();
  });

  it("requires every suggestion fragment, case-insensitively", () => {
    const expected = [{ file: "a", line: 1, suggestionIncludes: ["Every Language", "test id"] }];
    expect(
      scoreFindings([{ file: "a", line: 1, suggestion: "no test id, every language" }], expected)
        .f1,
    ).toBe(1);
    expect(scoreFindings([{ file: "a", line: 1 }], expected).f1).toBe(0);
  });
});
