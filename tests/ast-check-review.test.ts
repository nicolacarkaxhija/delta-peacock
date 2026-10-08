import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreFacts } from "../src/backtest/score.js";
import { runCli } from "../src/index.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const CATCH = `---
id: catch-what-throws
severity: MAJOR
paths: ['app/**']
check:
  type: ast
  files: ['app/**/*.js']
  rule: empty-catch
  message: A catch block handles the error it catches.
---
# Catch only what throws

A catch block handles the error it catches.
`;

const SCRIPT = [
  "function load() {",
  "  try {",
  "    return read();",
  "  } catch (e) {}",
  "}",
  "",
].join("\n");

async function cli(repo: string, args: string[]) {
  let err = "";
  const code = await runCli(args, {
    cwd: repo,
    env: {},
    out: () => undefined,
    err: (text) => {
      err += text;
    },
  });
  return { code, err };
}

describe("guidelines lint with a syntax tree check", () => {
  it("fails on an unknown rule, naming the guideline", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/catch.md", CATCH.replace("rule: empty-catch", "rule: no-eval"));
    const { code, err } = await cli(repo, ["guidelines", "lint"]);
    expect(code).toBe(1);
    expect(err).toContain('guideline "catch-what-throws" check: "rule" must be one of');
  });

  it("fails on a parameter the rule does not take", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/catch.md",
      CATCH.replace("rule: empty-catch", "rule: empty-catch\n  limit: 3"),
    );
    const { code, err } = await cli(repo, ["guidelines", "lint"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown key(s) limit for the empty-catch rule");
  });
});

describe("a facts only review with a syntax tree check", () => {
  it("posts the findings as facts with no model call, skips an unreadable script, and scores them as facts", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/catch.md", CATCH);
    write(
      repo,
      "delta-peacock.config.yaml",
      "model:\n  provider: none\nreview:\n  target: main\n  fetchTarget: false\n",
    );
    commitAll(repo, "guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "app/load.js", SCRIPT);
    write(repo, "app/legacy.js", "for each (var item in list) {}\n");
    commitAll(repo, "change");
    let calls = 0;
    const port = {
      complete: () => {
        calls += 1;
        return Promise.reject(new Error("a facts only run called a model"));
      },
    };
    let err = "";
    await runCli(["review", "--report", "review.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      modelPort: port,
      modelPortFor: () => port,
    });
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(calls).toBe(0);
    expect(err).toContain(
      "check: app/legacy.js skipped by the syntax tree checks: Unexpected token (1:4)",
    );
    expect(
      report.findings.map((one) => [
        `${one.file}:${String(one.line)}`,
        one.kind === "violation" ? one.guidelineQuote : "",
      ]),
    ).toEqual([["app/load.js:4", "A catch block handles the error it catches."]]);
    expect(report.checks).toMatchObject({ candidates: 1, findings: 1 });
    const reach = report.factsOnly;
    if (reach === undefined) throw new Error("the report holds no facts only section");
    expect(reach.leftToPerson).toEqual([]);
    expect(reach.notReviewed).toEqual([]);
    const score = scoreFacts(
      report.findings.map((one) => ({
        file: one.file,
        line: one.line,
        ...(one.kind === "violation" ? { guidelineId: one.guidelineId } : {}),
        severity: one.severity,
        title: one.title,
        body: "",
      })),
      [{ file: "app/load.js", line: 4, guidelineId: "catch-what-throws" }],
      [],
      reach,
    );
    expect(score).toMatchObject({ right: 1, facts: 1, missed: [], judgement: [] });
  });
});
