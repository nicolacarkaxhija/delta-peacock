import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { Severity } from "../src/domain/severity.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { FINDINGS_FILE, renderFindingsFile } from "../src/review/findings-file.js";
import type { ReportedFinding } from "../src/review/report.js";
import { readReviewRecord, writeReviewRecord } from "../src/review/review-record.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const schema = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../schema/finding.schema.json"), "utf8"),
) as object;
const validate = new Ajv({ allErrors: true }).compile(schema);

interface WrittenFinding {
  producer: string;
  rule: string;
  severity: string;
  file: string;
  range: { startLine: number; endLine?: number };
  message: string;
  suggested?: string;
  evidence?: string;
  fingerprint?: string;
}

function parsed(text: string): { schema: string; findings: WrittenFinding[] } {
  const value = JSON.parse(text) as unknown;
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  return value as { schema: string; findings: WrittenFinding[] };
}

function violation(overrides: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    kind: "violation",
    guidelineId: "no-console",
    severity: "MAJOR",
    file: "src/app.js",
    line: 2,
    title: "Console call added",
    body: "Replace the console.log with the logger. It keeps the output in one place. A third sentence.",
    guidelineQuote: "Use the logger\n  instead.",
    fingerprint: "abcdef123456",
    ...overrides,
  };
}

describe("renderFindingsFile", () => {
  it("writes a violation in the engine's shape, quoting its guideline, with no fingerprint of its own", () => {
    const file = parsed(
      renderFindingsFile([violation({ suggestion: "  logger.info(name);" })], "records/r1.json"),
    );
    expect(file.schema).toBe("findings-1");
    expect(file.findings).toEqual([
      {
        producer: "reviewer",
        rule: "no-console",
        severity: "warning",
        file: "src/app.js",
        range: { startLine: 2 },
        message:
          "Replace the console.log with the logger. It keeps the output in one place. Guideline: Use the logger instead.",
        suggested: "  logger.info(name);",
        evidence: "records/r1.json",
      },
    ]);
  });

  it.each<[Severity, string]>([
    ["BLOCKER", "error"],
    ["CRITICAL", "error"],
    ["MAJOR", "warning"],
    ["MINOR", "info"],
    ["INFO", "info"],
  ])("maps %s to the engine severity %s", (severity, expected) => {
    const file = parsed(renderFindingsFile([violation({ severity })]));
    expect(file.findings[0]?.severity).toBe(expected);
  });

  it("writes an observation under the observation rule, its title as the message when it has no body, and no evidence without a record", () => {
    const observation = {
      kind: "observation",
      severity: "INFO",
      file: "src/app.js",
      line: 3,
      title: "Name the magic number.",
      body: "",
      fingerprint: "abcdef123456",
    } as ReportedFinding;
    const file = parsed(renderFindingsFile([observation]));
    expect(file.findings).toEqual([
      {
        producer: "reviewer",
        rule: "observation",
        severity: "info",
        file: "src/app.js",
        range: { startLine: 3 },
        message: "Name the magic number.",
      },
    ]);
  });

  it("leaves out a baselined finding, a finding on no line and a guideline quote that is blank", () => {
    const file = parsed(
      renderFindingsFile([
        violation({ baselined: true }),
        violation({ unplaced: true }),
        violation({ line: 0 }),
        violation({ line: 4, guidelineQuote: "  " }),
      ]),
    );
    expect(file.findings.map((one) => [one.range.startLine, one.message])).toEqual([
      [4, "Replace the console.log with the logger. It keeps the output in one place."],
    ]);
  });

  it("writes an empty findings list for a review without findings", () => {
    expect(parsed(renderFindingsFile([])).findings).toEqual([]);
  });
});

const GUIDELINE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

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
      suggestion: "  logger.info(name);",
    },
  ],
});

const model: ModelPort = { complete: () => Promise.resolve({ text: REPLY }) };

function reviewedRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "change");
  return repo;
}

/** A file committed on the target branch, the feature branch checked out again. */
function onTarget(repo: string, file: string, text: string): void {
  git(repo, "checkout", "-q", "main");
  write(repo, file, text);
  commitAll(repo, "target");
  git(repo, "checkout", "-q", "feature");
}

async function review(repo: string, ...args: string[]): Promise<number> {
  return runCli(["review", "--target", "main", ...args], {
    cwd: repo,
    env: {},
    out: () => undefined,
    err: () => undefined,
    modelPort: model,
  });
}

function writtenIn(repo: string, dir: string): WrittenFinding[] {
  return parsed(readFileSync(path.join(repo, dir, FINDINGS_FILE), "utf8")).findings;
}

describe("review --findings", () => {
  it("writes the review's findings file and a record of the reviewed change the evidence names", async () => {
    const repo = reviewedRepo();
    const base = git(repo, "merge-base", "main", "HEAD").trim();
    expect(await review(repo, "--findings", "reports/findings")).toBe(0);
    const [finding] = writtenIn(repo, "reports/findings");
    expect(finding).toMatchObject({
      producer: "reviewer",
      rule: "no-console",
      severity: "warning",
      file: "src/app.js",
      range: { startLine: 2 },
      message: "Replace the console.log with the logger. Guideline: Use the logger instead.",
      suggested: "  logger.info(name);",
    });
    expect(finding?.fingerprint).toBeUndefined();
    const evidence = String(finding?.evidence);
    expect(evidence).toMatch(/^\.delta-peacock-cache\/reviews\/[^/]+\/review\.json$/);
    const record = readReviewRecord(repo, evidence);
    expect(record?.base).toBe(base);
    expect(record?.patch).toBe(git(repo, "diff", "--binary", "--no-color", base, "HEAD"));
  });

  it("takes the folder from output.findingsDir and records a staged review against HEAD", async () => {
    const repo = reviewedRepo();
    git(repo, "reset", "-q", "--soft", "HEAD~1");
    const code = await runCli(["review", "--staged"], {
      cwd: repo,
      env: { DELTA_PEACOCK_OUTPUT_FINDINGS_DIR: "out" },
      out: () => undefined,
      err: () => undefined,
      modelPort: model,
    });
    expect(code).toBe(0);
    const [finding] = writtenIn(repo, "out");
    const record = readReviewRecord(repo, String(finding?.evidence));
    expect(record?.base).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(record?.patch).toBe(git(repo, "diff", "--cached", "--binary", "--no-color"));
  });

  it("records an incremental review from the last reviewed commit", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "function greet(name) {\n  return name;\n}\n");
    commitAll(repo, "first");
    const anchor = git(repo, "rev-parse", "HEAD").trim();
    write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
    commitAll(repo, "second");
    expect(await review(repo, "--findings", "f", "--last-reviewed-commit", anchor)).toBe(0);
    const record = readReviewRecord(repo, String(writtenIn(repo, "f")[0]?.evidence));
    expect(record?.base).toBe(anchor);
    expect(record?.patch).toBe(git(repo, "diff", "--binary", "--no-color", anchor, "HEAD"));
  });

  it.each<[string, (repo: string) => string[]]>([
    ["nothing in scope changed", (repo) => (git(repo, "checkout", "-q", "main"), [])],
    ["the change is too large", () => ["--max-diff-bytes", "1"]],
    [
      "no guideline applies",
      (repo) => (
        onTarget(
          repo,
          "guidelines/no-console.md",
          GUIDELINE.replace("---\n#", "paths: [lib/**]\n---\n#"),
        ),
        []
      ),
    ],
    [
      "no guideline is usable",
      (repo) => (
        onTarget(repo, "broken/rule.md", "# No frontmatter\n"),
        ["--guidelines-dir", "broken"]
      ),
    ],
  ])("empties a stale findings file when %s", async (_situation, arrange) => {
    const repo = reviewedRepo();
    const extra = arrange(repo);
    write(repo, `f/${FINDINGS_FILE}`, renderFindingsFile([violation()]));
    expect(await review(repo, "--findings", "f", ...extra)).toBe(0);
    expect(writtenIn(repo, "f")).toEqual([]);
  });

  it("writes no findings file without the option", async () => {
    const repo = reviewedRepo();
    expect(await review(repo)).toBe(0);
    expect(existsSync(path.join(repo, ".delta-peacock-cache", "reviews"))).toBe(false);
  });
});

describe("writeReviewRecord", () => {
  it("records nothing when the target is not in the clone", () => {
    const repo = reviewedRepo();
    expect(
      writeReviewRecord(repo, { staged: false, target: "origin/absent" }, new Date(0)),
    ).toBeUndefined();
    expect(existsSync(path.join(repo, ".delta-peacock-cache"))).toBe(false);
  });
});

const RECORDS = ".delta-peacock-cache/reviews";

describe("readReviewRecord", () => {
  it("returns nothing for an evidence path with no record, outside the records, a record of another shape, without a commit as its base, or a missing patch", async () => {
    const repo = reviewedRepo();
    const record = (base: string): string => JSON.stringify({ schema: "review-record-1", base });
    const sha = git(repo, "rev-parse", "HEAD").trim();
    expect(readReviewRecord(repo, `${RECORDS}/nowhere/review.json`)).toBeUndefined();
    write(repo, "outside/review.json", record(sha));
    write(repo, "outside/diff.patch", "");
    expect(readReviewRecord(repo, `${RECORDS}/../../outside/review.json`)).toBeUndefined();
    expect(readReviewRecord(repo, "outside/review.json")).toBeUndefined();
    write(repo, `${RECORDS}/bad/review.json`, "{ not json");
    expect(readReviewRecord(repo, `${RECORDS}/bad/review.json`)).toBeUndefined();
    write(repo, `${RECORDS}/other/review.json`, JSON.stringify({ schema: "something-else" }));
    expect(readReviewRecord(repo, `${RECORDS}/other/review.json`)).toBeUndefined();
    write(repo, `${RECORDS}/baseless/review.json`, JSON.stringify({ schema: "review-record-1" }));
    expect(readReviewRecord(repo, `${RECORDS}/baseless/review.json`)).toBeUndefined();
    write(repo, `${RECORDS}/option/review.json`, record("--output=x"));
    write(repo, `${RECORDS}/option/diff.patch`, "");
    expect(readReviewRecord(repo, `${RECORDS}/option/review.json`)).toBeUndefined();
    expect(await review(repo, "--findings", "f")).toBe(0);
    const evidence = String(writtenIn(repo, "f")[0]?.evidence);
    rmSync(path.join(repo, path.dirname(evidence), "diff.patch"));
    expect(readReviewRecord(repo, evidence)).toBeUndefined();
  });
});
