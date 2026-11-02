import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBacktestCases } from "../src/backtest/cases.js";
import { intakeFalsePositives } from "../src/backtest/intake.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { FINDINGS_FILE } from "../src/review/findings-file.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

const BASE_APP = "function greet(name) {\n  return 'hello ' + name;\n}\n";

const REPLY = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      quote: "console.log(name);",
      title: "Console call added",
      body: "Replace the console.log with the logger.",
      guidelineQuote: "Use the logger instead.",
    },
  ],
});

function port(text: string): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

const FINGERPRINT = "0123456789abcdef";
const INTAKE = "findings/backtest";

/** A reviewed repository whose review wrote its findings file, and the finding it holds. */
async function reviewed(): Promise<{ repo: string; finding: Record<string, unknown> }> {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "change");
  const code = await runCli(["review", "--target", "main", "--findings", "reports/findings"], {
    cwd: repo,
    env: {},
    out: () => undefined,
    err: () => undefined,
    modelPort: port(REPLY),
  });
  expect(code).toBe(0);
  const text = readFileSync(path.join(repo, "reports/findings", FINDINGS_FILE), "utf8");
  const [finding] = (JSON.parse(text) as { findings: Record<string, unknown>[] }).findings;
  return { repo, finding: finding ?? {} };
}

/** The file the engine writes when a person marks the finding as a false positive. */
function markFalsePositive(
  repo: string,
  finding: Record<string, unknown>,
  name = FINGERPRINT,
  fingerprint = FINGERPRINT,
): void {
  const body = {
    schema: "finding-backtest-1",
    fingerprint,
    reason: "the console is the logger in this script",
    at: "2026-11-02",
    finding: { ...finding, fingerprint },
  };
  write(repo, `${INTAKE}/${name}.json`, `${JSON.stringify(body, null, 2)}\n`);
}

function casesDir(): string {
  return mkdtempSync(path.join(tmpdir(), "intake-cases-"));
}

describe("intakeFalsePositives", () => {
  it("turns a false positive of the reviewer into a backtest case the loader picks up", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, finding);
    write(repo, `${INTAKE}/notes.txt`, "not a case");
    const cases = casesDir();

    const outcomes = intakeFalsePositives(repo, INTAKE, cases);

    const name = `false-positive-${FINGERPRINT}`;
    expect(outcomes).toEqual([{ file: `${INTAKE}/${FINGERPRINT}.json`, case: name }]);
    const [loaded] = loadBacktestCases(cases);
    expect(loaded?.name).toBe(name);
    expect(loaded?.othersUnjudged).toBe(true);
    expect(loaded?.expected).toEqual([]);
    expect(loaded?.noFinding).toEqual([
      {
        file: "src/app.js",
        line: 2,
        guidelineId: "no-console",
        why: "the console is the logger in this script",
      },
    ]);
    const dir = path.join(cases, name);
    expect(readFileSync(path.join(dir, "base/src/app.js"), "utf8")).toBe(BASE_APP);
    expect(readFileSync(path.join(dir, "base/guidelines/no-console.md"), "utf8")).toBe(GUIDELINE);
    expect(readFileSync(path.join(dir, "diff.patch"), "utf8")).toContain("+  console.log(name);");
    expect(JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8"))).toEqual({
      from: `${INTAKE}/${FINGERPRINT}.json`,
      fingerprint: FINGERPRINT,
      at: "2026-11-02",
      evidence: finding["evidence"],
    });
  });

  it("keeps an observation's span without a guideline and an end line past the start", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, {
      ...finding,
      rule: "observation",
      range: { startLine: 2, endLine: 3 },
    });
    const cases = casesDir();
    intakeFalsePositives(repo, INTAKE, cases);
    expect(loadBacktestCases(cases)[0]?.noFinding).toEqual([
      { file: "src/app.js", line: 2, endLine: 3, why: "the console is the logger in this script" },
    ]);
  });

  it("skips a case already taken in, another producer's finding, a file of another shape, a finding with no record and a record from another clone", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, finding);
    const cases = casesDir();
    intakeFalsePositives(repo, INTAKE, cases);
    markFalsePositive(repo, { ...finding, producer: "axe" }, "b", "1111111111111111");
    write(repo, `${INTAKE}/c.json`, JSON.stringify({ schema: "finding-backtest-1" }));
    write(repo, `${INTAKE}/d.json`, "{ broken");
    markFalsePositive(repo, { ...finding, evidence: "gone/review.json" }, "e", "2222222222222222");
    const unlinked = Object.fromEntries(
      Object.entries(finding).filter(([key]) => key !== "evidence"),
    );
    markFalsePositive(repo, unlinked, "f", "3333333333333333");
    write(
      repo,
      ".delta-peacock-cache/reviews/far/review.json",
      JSON.stringify({ schema: "review-record-1", base: "0".repeat(40) }),
    );
    write(repo, ".delta-peacock-cache/reviews/far/diff.patch", "");
    markFalsePositive(
      repo,
      { ...finding, evidence: ".delta-peacock-cache/reviews/far/review.json" },
      "g",
      "4444444444444444",
    );

    expect(intakeFalsePositives(repo, INTAKE, cases)).toEqual([
      { file: `${INTAKE}/${FINGERPRINT}.json`, skipped: "already a backtest case" },
      { file: `${INTAKE}/b.json`, skipped: "not a reviewer finding" },
      { file: `${INTAKE}/c.json`, skipped: "not a false positive file" },
      { file: `${INTAKE}/d.json`, skipped: "not a false positive file" },
      { file: `${INTAKE}/e.json`, skipped: "no review record at gone/review.json" },
      { file: `${INTAKE}/f.json`, skipped: "no review record: the finding names no evidence" },
      {
        file: `${INTAKE}/g.json`,
        skipped:
          "the base commit of .delta-peacock-cache/reviews/far/review.json is not in this clone",
      },
    ]);
    expect(existsSync(path.join(cases, "false-positive-1111111111111111"))).toBe(false);
  });

  it("refuses a false positive folder that does not exist", () => {
    expect(() => intakeFalsePositives(casesDir(), "missing", casesDir())).toThrow(
      "false positive folder not found: missing",
    );
  });
});

describe("backtest --intake", () => {
  it("takes the false positives in before it replays the cases", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, finding);
    const cases = casesDir();
    let stdout = "";
    const code = await runCli(
      ["backtest", "--cases", cases, "--intake", INTAKE, "--repeats", "1"],
      {
        cwd: repo,
        env: {},
        out: (text) => {
          stdout += text;
        },
        err: () => undefined,
        modelPort: port('{"findings": []}'),
      },
    );
    expect(stdout).toContain(
      `intake: ${INTAKE}/${FINGERPRINT}.json became case false-positive-${FINGERPRINT}`,
    );
    expect(stdout).toContain(`| false-positive-${FINGERPRINT} | 0 | 0 | 0 | 0 | 0 |`);
    expect(code).toBe(0);
  });

  it("judges only the marked finding: another finding of the review is neither wrong nor drift", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, finding);
    const cases = casesDir();
    const other = {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 3,
      quote: "return name;",
      title: "Return value logged nowhere",
      body: "Log the returned name with the logger.",
      guidelineQuote: "Use the logger instead.",
    };
    const replies = [
      JSON.stringify({
        findings: [...(JSON.parse(REPLY) as { findings: unknown[] }).findings, other],
      }),
      REPLY,
    ];
    let calls = 0;
    let stdout = "";
    const code = await runCli(
      ["backtest", "--cases", cases, "--intake", INTAKE, "--repeats", "2", "--concurrency", "1"],
      {
        cwd: repo,
        env: {},
        out: (text) => {
          stdout += text;
        },
        err: () => undefined,
        modelPort: { complete: () => Promise.resolve({ text: replies[calls++ % 2] ?? "" }) },
      },
    );
    expect(code).toBe(2);
    expect(stdout).toContain(
      `| false-positive-${FINGERPRINT} | 0 | 1/1 | 0/0 | 1/1 | 0/0 | 0/0 | 0 |`,
    );
    expect(stdout).toContain("src/app.js:2 no-console MAJOR");
    expect(stdout).not.toContain("not in the human judgement");
  });

  it("names each false positive it skipped", async () => {
    const { repo, finding } = await reviewed();
    markFalsePositive(repo, { ...finding, producer: "axe" });
    const cases = casesDir();
    let stdout = "";
    await runCli(["backtest", "--cases", cases, "--intake", INTAKE, "--repeats", "1"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port('{"findings": []}'),
    }).catch(() => 1);
    expect(stdout).toContain(
      `intake: ${INTAKE}/${FINGERPRINT}.json skipped: not a reviewer finding`,
    );
  });
});
