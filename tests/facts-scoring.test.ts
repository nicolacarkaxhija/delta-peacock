import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreFacts } from "../src/backtest/score.js";
import { formatTable, runBench } from "../src/bench/harness.js";
import { splitByReach } from "../src/bench/scoring.js";
import { BASELINE_FILE } from "../src/commands/backtest.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { git } from "./helpers/git.js";

const NUMBERS = `---
id: no-magic-numbers
severity: MAJOR
paths: ['src/**']
---
# No magic numbers

Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.
`;

const CONSOLE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

const CONFIG = `scm:
  provider: local
model:
  provider: bedrock
  id: some-model
review:
  target: main
  include: ['src/**']
`;

const BASE = "export function run(): number {\n  return 0;\n}\n";
const AFTER = [
  "const RETRY_LIMIT = 3;",
  "// the rows on one page",
  "const PAGE_ROWS = 25;",
  "export function run(): number {",
  "  console.log(PAGE_ROWS);",
  "  return RETRY_LIMIT;",
  "}",
  "",
].join("\n");

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function diffOf(before: string, after: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "facts-diff-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, "src/app.ts", before);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=f", "-c", "user.email=f@e", "commit", "-q", "-m", "base");
  write(repo, "src/app.ts", after);
  return git(repo, "diff");
}

function makeCase(expected: unknown): string {
  const casesDir = mkdtempSync(path.join(tmpdir(), "facts-cases-"));
  const dir = path.join(casesDir, "one");
  write(dir, "base/src/app.ts", BASE);
  write(dir, "base/guidelines/no-magic-numbers.md", NUMBERS);
  write(dir, "base/guidelines/no-console.md", CONSOLE);
  write(dir, "base/delta-peacock.config.yaml", CONFIG);
  write(dir, "diff.patch", diffOf(BASE, AFTER));
  write(dir, "expected.json", JSON.stringify(expected));
  return casesDir;
}

const refusing: ModelPort = {
  complete: () => Promise.reject(new Error("a facts only run called a model")),
};

describe("scoring a facts only run", () => {
  it("splits a miss that needs a judgement from a real one", () => {
    const score = scoreFacts(
      [
        {
          file: "src/app.ts",
          line: 1,
          guidelineId: "no-magic-numbers",
          severity: "MAJOR",
          title: "No reason next to RETRY_LIMIT",
          body: "",
        },
      ],
      [
        { file: "src/app.ts", line: 1, guidelineId: "no-magic-numbers" },
        { file: "src/app.ts", line: 3, guidelineId: "no-magic-numbers" },
        { file: "src/app.ts", line: 5, guidelineId: "no-console" },
        { file: "src/app.ts", line: 6 },
        { file: "src/app.ts", line: 9, guidelineId: "no-magic-numbers" },
      ],
      [],
      {
        leftToPerson: [{ file: "src/app.ts", line: 3, guidelineId: "no-magic-numbers" }],
        notReviewed: ["no-console"],
      },
    );
    expect(score.right).toBe(1);
    expect(score.facts).toBe(2);
    expect(score.judgement.map((one) => one.line)).toEqual([3, 5, 6]);
    expect(score.missed.map((one) => one.line)).toEqual([9]);
  });

  it("owes a bench case only the findings a fact decides", async () => {
    const reach = {
      leftToPerson: [{ file: "a.ts", line: 4, guidelineId: "g" }],
      notReviewed: ["h"],
    };
    const split = splitByReach(
      [{ file: "a.ts", line: 1, guidelineId: "g" }],
      [
        { file: "a.ts", line: 1, guidelineId: "g" },
        { file: "a.ts", line: 5, guidelineId: "g" },
        { file: "a.ts", line: 9, guidelineId: "h" },
        { file: "a.ts", line: 20, guidelineId: "g" },
      ],
      reach,
    );
    expect(split.facts.map((one) => one.line)).toEqual([1, 20]);
    expect(split.judgement.map((one) => one.line)).toEqual([5, 9]);
    const outcome = await runBench(
      [
        {
          name: "c",
          dir: "c",
          diff: "",
          expected: [
            { file: "a.ts", line: 1, guidelineId: "g" },
            { file: "a.ts", line: 9, guidelineId: "h" },
          ],
        },
      ],
      () =>
        Promise.resolve({ produced: [{ file: "a.ts", line: 1, guidelineId: "g" }], facts: reach }),
    );
    expect(outcome.cases[0]?.judgement).toBe(1);
    expect(outcome.aggregate?.recall).toBe(1);
    expect(formatTable(outcome)).toContain("| judgement |");
    expect(formatTable(outcome)).toMatch(/\| aggregate \| \| 100% \| 100% \| 100% \| 1 \|/);
  });
});

describe("backtest and bench with provider none", () => {
  it("replays a case with no model and reports what needs a judgement", async () => {
    const casesDir = makeCase({
      findings: [
        { file: "src/app.ts", line: 1, guidelineId: "no-magic-numbers" },
        { file: "src/app.ts", line: 3, guidelineId: "no-magic-numbers" },
        { file: "src/app.ts", line: 5, guidelineId: "no-console" },
      ],
    });
    let out = "";
    const code = await runCli(
      ["backtest", "--cases", casesDir, "--repeats", "1", "--provider", "none"],
      {
        cwd: casesDir,
        env: {},
        out: (text) => {
          out += text;
        },
        err: () => undefined,
        modelPort: refusing,
      },
    );
    expect(out).toContain("| one | 3 | 1 | 1 | 1 | 0 | 0 | 2 | 0 |");
    expect(out).toContain(
      "facts only over 1 repeat(s): 1 of 1 fact findings found, 0 wrong, 2 of 3 expected findings need a judgement, drift 0",
    );
    expect(out).toContain("one needs a judgement: src/app.ts:3 no-magic-numbers");
    expect(out).toContain("backtest passed on facts only; the baseline stays as it was");
    expect(code).toBe(0);
    expect(existsSync(path.join(casesDir, BASELINE_FILE))).toBe(false);
  });

  it("fails on a fact finding it missed", async () => {
    const casesDir = makeCase({
      findings: [{ file: "src/app.ts", line: 7, guidelineId: "no-magic-numbers" }],
    });
    let out = "";
    const code = await runCli(
      ["backtest", "--cases", casesDir, "--repeats", "1", "--provider", "none"],
      {
        cwd: casesDir,
        env: {},
        out: (text) => {
          out += text;
        },
        err: () => undefined,
        modelPort: refusing,
      },
    );
    expect(code).toBe(2);
    expect(out).toContain("one r1 missed: src/app.ts:7 no-magic-numbers");
    expect(out).toContain("one r1 wrong: src/app.ts:1 no-magic-numbers");
  });

  it("benches with no model and scores only what a fact decides", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "facts-bench-"));
    const caseDir = path.join(root, "cases", "01");
    write(caseDir, "diff.patch", diffOf(BASE, AFTER));
    write(caseDir, "guidelines/no-magic-numbers.md", NUMBERS);
    write(caseDir, "guidelines/no-console.md", CONSOLE);
    write(caseDir, "files/src/app.ts", AFTER);
    write(
      caseDir,
      "expected.json",
      JSON.stringify({
        findings: [
          { file: "src/app.ts", line: 1, guidelineId: "no-magic-numbers" },
          { file: "src/app.ts", line: 5, guidelineId: "no-console" },
        ],
      }),
    );
    let out = "";
    const code = await runCli(
      [
        "bench",
        "--cases",
        path.join(root, "cases"),
        "--provider",
        "none",
        "--report",
        "bench.json",
      ],
      {
        cwd: root,
        env: {},
        out: (text) => {
          out += text;
        },
        err: () => undefined,
        modelPort: refusing,
      },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/\| 01 \| 1 \| 100% \| 100% \| 100% \| 1 \|/);
    const report = JSON.parse(readFileSync(path.join(root, "bench.json"), "utf8")) as {
      cases: { usage?: unknown }[];
    };
    expect(report.cases[0]?.usage).toBeUndefined();
  });
});
