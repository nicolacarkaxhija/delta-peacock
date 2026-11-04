import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { runPrepass, type PrepassInput } from "../src/review/semgrep/prepass.js";
import type { SemgrepHit, SemgrepRun } from "../src/review/semgrep/run.js";

const SENTENCE = "A log call never chains on getLogger.";

const ruled = (id: string, extra: Partial<Guideline> = {}): Guideline => ({
  id,
  severity: "MINOR",
  title: "Assign the logger once",
  body: SENTENCE,
  sourcePath: `guidelines/${id}.md`,
  languages: ["javascript"],
  paths: ["cartridges/**"],
  tags: [],
  check: {
    type: "semgrep",
    files: [],
    rules: `rules:\n  - id: chained\n    languages: [javascript]\n    severity: WARNING\n    message: ${SENTENCE}\n    pattern: a()\n`,
    message: SENTENCE,
  },
  ...extra,
});

const judged: Guideline = {
  id: "natural-comments",
  severity: "MINOR",
  title: "Natural comments",
  body: "Comments say why.",
  sourcePath: "guidelines/natural-comments.md",
  languages: [],
  paths: ["src/**"],
  tags: ["judged"],
};

const HEADER = (file: string): string =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`;
const GIFT_HIT = "@@ -1,2 +1,3 @@\n a\n+chained();\n b\n";
const GIFT_CLEAN = "@@ -10,2 +11,3 @@\n c\n+clean();\n d\n";
const GIFT = `${HEADER("cartridges/gift.js")}${GIFT_HIT}${GIFT_CLEAN}`;
const APP = `${HEADER("src/app.js")}@@ -1 +1,2 @@\n x\n+y();\n`;

const SOURCES: Record<string, string> = {
  "cartridges/gift.js": [
    "a",
    "chained();",
    "b",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "c",
    "clean();",
    "d",
  ].join("\n"),
  "src/app.js": "x\ny();\n",
};

const hit = (overrides: Partial<SemgrepHit> = {}): SemgrepHit => ({
  ruleId: "logger-assigned-once.chained",
  path: "cartridges/gift.js",
  startLine: 2,
  endLine: 2,
  ...overrides,
});

function input(
  guidelines: readonly Guideline[],
  run: SemgrepRun,
  extra: Partial<PrepassInput> = {},
): { input: PrepassInput; calls: { config: string; files: string[] }[] } {
  const calls: { config: string; files: string[] }[] = [];
  return {
    calls,
    input: {
      guidelines,
      diff: GIFT + APP,
      read: (file) => SOURCES[file]?.split("\n"),
      generalPass: false,
      runner: (config, files) => {
        calls.push({ config, files: [...files.keys()] });
        return Promise.resolve(run);
      },
      ...extra,
    },
  };
}

const ok = (hits: SemgrepHit[], warnings: string[] = []): SemgrepRun => ({
  ok: true,
  version: "1.183.0",
  hits,
  warnings,
});

describe("runPrepass", () => {
  it("does nothing when no guideline declares a semgrep check", async () => {
    const { input: given, calls } = input([judged], ok([]));
    expect(await runPrepass(given)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("maps a hit to a violation from producer semgrep and withholds the hunk it settles", async () => {
    const { input: given, calls } = input([ruled("logger-assigned-once"), judged], ok([hit()]));
    const outcome = await runPrepass(given);
    expect(calls).toEqual([
      {
        config: expect.stringContaining("logger-assigned-once.chained") as string,
        files: ["cartridges/gift.js"],
      },
    ]);
    expect(outcome?.findings).toEqual([
      {
        kind: "violation",
        producer: "semgrep",
        guidelineId: "logger-assigned-once",
        severity: "MINOR",
        file: "cartridges/gift.js",
        line: 2,
        title: SENTENCE,
        body: "Matched by the semgrep rule chained.",
        quote: "chained();",
        guidelineQuote: SENTENCE,
      },
    ]);
    expect(outcome?.settled).toEqual(["logger-assigned-once"]);
    expect(outcome?.modelDiff).toBe(`${HEADER("cartridges/gift.js")}${GIFT_CLEAN}${APP}`);
    expect(outcome?.withheld).toEqual([{ file: "cartridges/gift.js", hunk: "@@ -1,2 +1,3 @@" }]);
    expect(outcome?.engine).toBe("1.183.0");
    expect(outcome?.ruleSets).toEqual(["local"]);
    expect(outcome?.failure).toBeUndefined();
  });

  it("names the pack and version a rule set was derived from", async () => {
    const packed = ruled("logger-assigned-once", { pack: "sfra" });
    const check = packed.check;
    if (check?.type !== "semgrep") throw new Error("no check");
    const { input: given } = input([{ ...packed, check: { ...check, version: "0.2.0" } }], ok([]));
    expect((await runPrepass(given))?.ruleSets).toEqual(["sfra 0.2.0"]);
  });

  it("names a pack rule set with no version as unversioned", async () => {
    const { input: given } = input([ruled("logger-assigned-once", { pack: "house" })], ok([]));
    expect((await runPrepass(given))?.ruleSets).toEqual(["house unversioned"]);
  });

  it("counts a hit on a file the diff does not hold as off the change", async () => {
    const { input: given } = input(
      [ruled("logger-assigned-once")],
      ok([hit({ path: "cartridges/other.js" })]),
    );
    const outcome = await runPrepass(given);
    expect(outcome?.findings).toEqual([]);
    expect(outcome?.notices).toEqual(["semgrep: 1 hit(s) off the change"]);
  });

  it("places a hit that spans lines on its first added line and skips a hit off the change", async () => {
    const { input: given } = input(
      [ruled("logger-assigned-once")],
      ok([hit({ startLine: 1, endLine: 3 }), hit({ startLine: 30, endLine: 30 })]),
    );
    const outcome = await runPrepass(given);
    expect(outcome?.findings.map((finding) => finding.line)).toEqual([2]);
    expect(outcome?.notices).toContain("semgrep: 1 hit(s) off the change");
  });

  it("skips a hit on a file its guideline does not cover and a hit of an unknown rule", async () => {
    const { input: given } = input(
      [ruled("logger-assigned-once")],
      ok([hit({ path: "src/app.js" }), hit({ ruleId: "elsewhere.rule" })]),
    );
    expect((await runPrepass(given))?.findings).toEqual([]);
  });

  it("keeps one finding per guideline and line", async () => {
    const { input: given } = input([ruled("logger-assigned-once")], ok([hit(), hit()]));
    expect((await runPrepass(given))?.findings).toHaveLength(1);
  });

  it("keeps a check's globs on top of the guideline scope", async () => {
    const guideline = ruled("logger-assigned-once");
    const check = guideline.check;
    if (check?.type !== "semgrep") throw new Error("no check");
    const { input: given, calls } = input(
      [{ ...guideline, check: { ...check, files: ["cartridges/**/*.ts"] } }],
      ok([hit()]),
    );
    const outcome = await runPrepass(given);
    expect(calls).toEqual([]);
    expect(outcome?.findings).toEqual([]);
    expect(outcome?.modelDiff).toBe(GIFT + APP);
  });

  it("passes the warnings of a run on as notices", async () => {
    const { input: given } = input([ruled("logger-assigned-once")], ok([], ["a.js: parse error"]));
    expect((await runPrepass(given))?.notices).toContain("semgrep: a.js: parse error");
  });

  it("leaves a hunk with the model while a judged guideline covers its file", async () => {
    const wide = { ...judged, paths: [] };
    const { input: given } = input([ruled("logger-assigned-once"), wide], ok([hit()]));
    const outcome = await runPrepass(given);
    expect(outcome?.findings).toHaveLength(1);
    expect(outcome?.modelDiff).toBe(GIFT + APP);
    expect(outcome?.withheld).toEqual([]);
  });

  it("leaves a hunk with the model under the general pass", async () => {
    const { input: given } = input([ruled("logger-assigned-once")], ok([hit()]), {
      generalPass: true,
    });
    expect((await runPrepass(given))?.modelDiff).toBe(GIFT + APP);
  });

  it("leaves a guideline that is also judged to the model and still reports its hits", async () => {
    const both = ruled("logger-assigned-once", { tags: ["judged"] });
    const { input: given } = input([both], ok([hit()]));
    const outcome = await runPrepass(given);
    expect(outcome?.settled).toEqual([]);
    expect(outcome?.findings).toHaveLength(1);
    expect(outcome?.modelDiff).toBe(GIFT + APP);
  });

  it("settles the rule guidelines without a run when no changed file is in their scope", async () => {
    const { input: given, calls } = input([ruled("logger-assigned-once")], ok([]), { diff: APP });
    const outcome = await runPrepass(given);
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({
      settled: ["logger-assigned-once"],
      findings: [],
      modelDiff: APP,
    });
    expect(outcome?.engine).toBeUndefined();
  });

  it("skips a changed file it cannot read", async () => {
    const { input: given, calls } = input([ruled("logger-assigned-once")], ok([]), {
      read: () => undefined,
    });
    await runPrepass(given);
    expect(calls).toEqual([]);
  });

  it("hands the model the whole diff and settles nothing when semgrep fails", async () => {
    const { input: given } = input([ruled("logger-assigned-once")], {
      ok: false,
      reason: "timed out after 60s",
    });
    const outcome = await runPrepass(given);
    expect(outcome).toMatchObject({
      settled: [],
      findings: [],
      modelDiff: GIFT + APP,
      withheld: [],
      failure: "timed out after 60s",
    });
  });
});
