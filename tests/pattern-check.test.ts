import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { parseGuidelineContent } from "../src/guidelines/loader.js";
import { runCli } from "../src/index.js";
import { splitChecked } from "../src/review/checks/index.js";
import { findCandidates } from "../src/review/checks/detect.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const LOGGER = String.raw`---
id: logger-category
severity: MAJOR
paths: ['cartridges/**']
check:
  type: pattern
  files: ['cartridges/**/*.js']
  added: 'getLogger\(\s*[''"][^''"]+[''"]\s*\)'
  unless: 'getLogger\([^,]+,\s*[''"]'
  message: getLogger takes a category as its second argument.
---
# Loggers name their category

getLogger takes a category as its second argument.
`;

const STRICT = String.raw`---
id: strict-mode
severity: MINOR
check:
  type: pattern
  files: ['cartridges/**/*.js']
  absent: '^\s*[''"]use strict[''"];'
  scope: file
  message: Every script opens with the use strict directive.
---
# Strict mode

Every script opens with the use strict directive.
`;

const capped = (cap: number): string =>
  LOGGER.replace("  message:", `  maxPerFile: ${String(cap)}\n  message:`);

function guideline(content: string): Guideline {
  const parsed = parseGuidelineContent(content, "guidelines/rule.md");
  if (!("guideline" in parsed)) throw new Error(JSON.stringify(parsed));
  return parsed.guideline;
}

function problem(content: string): string {
  const parsed = parseGuidelineContent(content, "guidelines/rule.md");
  return "problem" in parsed ? parsed.problem : "";
}

const all = (text: string): Set<number> => new Set(text.split("\n").map((_, index) => index + 1));

function found(rule: Guideline, files: Record<string, string>, changed?: Record<string, number[]>) {
  const { bound } = splitChecked([rule], {});
  return findCandidates(bound, {
    changed: new Map(
      Object.keys(files).map((file) => [
        file,
        changed?.[file] !== undefined ? new Set(changed[file]) : all(files[file] ?? ""),
      ]),
    ),
    read: (file) => files[file],
    files: () => Object.keys(files),
    testIdAttribute: "data-testid",
  });
}

const SCRIPT = [
  "'use strict';",
  "var log = Logger.getLogger('checkout');",
  "var ok = Logger.getLogger('checkout', 'payment');",
  'var other = Logger.getLogger("orders");',
  "",
].join("\n");

describe("the pattern check", () => {
  it("is owned by the guideline that declares it, with no binding", () => {
    const { bound, free } = splitChecked([guideline(LOGGER)], {});
    expect(bound.map(({ check }) => check)).toEqual(["pattern"]);
    expect(free).toEqual([]);
  });

  it("flags every added line that matches, quoting the message", () => {
    const result = found(guideline(LOGGER), { "cartridges/app/script.js": SCRIPT });
    expect(result.map((one) => one.line)).toEqual([2, 4]);
    expect(result[0]).toMatchObject({
      check: "pattern",
      shape: "pattern-added",
      quote: "var log = Logger.getLogger('checkout');",
      title: "getLogger takes a category as its second argument",
      sentence: "getLogger takes a category as its second argument.",
    });
    expect(result[0]?.body).toContain("getLogger('checkout')");
    expect(result[0]?.judge).toBeUndefined();
  });

  it("leaves lines the change did not add and files outside its globs alone", () => {
    const rule = guideline(LOGGER);
    expect(
      found(rule, { "cartridges/app/script.js": SCRIPT }, { "cartridges/app/script.js": [1, 3] }),
    ).toEqual([]);
    expect(found(rule, { "cartridges/app/template.isml": SCRIPT })).toEqual([]);
    expect(found(rule, { "scripts/build.js": SCRIPT })).toEqual([]);
  });

  it("lets a match of unless on the same line excuse it", () => {
    const rule = guideline(LOGGER);
    const lines = [
      "var pair = [Logger.getLogger('checkout', 'tax'), Logger.getLogger('audit')];",
      "var b = Logger.getLogger('x');",
      "",
    ].join("\n");
    expect(found(rule, { "cartridges/a.js": lines }).map((one) => one.line)).toEqual([2]);
  });

  it("reports a covered file that never holds the absent pattern, on its first added line", () => {
    const rule = guideline(STRICT);
    const missing = ["var a = 1;", "var b = 2;", ""].join("\n");
    const result = found(rule, { "cartridges/a.js": missing }, { "cartridges/a.js": [2] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ shape: "pattern-absent", line: 2, quote: "var b = 2;" });
    expect(found(rule, { "cartridges/b.js": SCRIPT })).toEqual([]);
  });

  it("caps the findings of one file at maxPerFile and counts the rest", () => {
    const lines = [
      "getLogger('a');",
      "getLogger('b');",
      "getLogger('c');",
      "getLogger('d');",
      "",
    ].join("\n");
    const result = found(guideline(capped(2)), { "cartridges/a.js": lines });
    expect(result.map((one) => one.line)).toEqual([1, 2]);
    expect(result[1]?.body).toContain("2 more added line(s) in this file match as well.");
    expect(found(guideline(capped(4)), { "cartridges/a.js": lines })).toHaveLength(4);
  });
});

describe("the pattern examples in the checks guide", () => {
  const rule = (id: string, check: string, sentence: string): Guideline =>
    guideline(`---\nid: ${id}\nseverity: MAJOR\ncheck:\n${check}\n---\n# ${id}\n\n${sentence}\n`);

  it("flags Rhino era imports", () => {
    const rhino = rule(
      "no-rhino-imports",
      String.raw`  type: pattern
  added: '\b(?:importPackage|importClass)\s*\('
  message: "Scripts load modules with require, never with importPackage or importClass."`,
      "Scripts load modules with require, never with importPackage or importClass.",
    );
    const lines = ["importPackage(dw.system);", "var a = require('x');", "importClass (Foo);", ""];
    expect(found(rhino, { "a.js": lines.join("\n") }).map((one) => one.line)).toEqual([1, 3]);
  });

  it("flags session.custom writes outside the allowlist", () => {
    const session = rule(
      "session-allowlist",
      String.raw`  type: pattern
  added: 'session\.custom\.\w+\s*=[^=]'
  unless: 'session\.custom\.(?:basketToken|lastSearch)\s*='
  message: "Only basketToken and lastSearch live in session.custom."`,
      "Only basketToken and lastSearch live in session.custom.",
    );
    const lines = [
      "session.custom.basketToken = token;",
      "session.custom.promo = code;",
      "if (session.custom.promo === code) {}",
      "",
    ];
    expect(found(session, { "a.js": lines.join("\n") }).map((one) => one.line)).toEqual([2]);
  });
});

describe("a declared pattern check that cannot run", () => {
  it("names the guideline, the key and the regex error", () => {
    const broken = LOGGER.replace(String.raw`added: 'getLogger\(`, "added: 'getLogger(");
    expect(problem(broken)).toMatch(
      /^guidelines\/rule\.md: guideline "logger-category" check: "added" is not a valid regex: .*Unterminated group/,
    );
  });

  it("refuses a message the guideline does not say, a wrong shape and an unknown key", () => {
    expect(problem(LOGGER.replace("message: getLogger", "message: A logger"))).toContain(
      '"message" must be a sentence the guideline says word for word',
    );
    expect(problem(STRICT.replace("scope: file", "scope: line"))).toContain(
      '"absent" reads files: scope file',
    );
    expect(problem(LOGGER.replace("  unless:", "  absent: x\n  unless:"))).toContain(
      'exactly one of "added" and "absent"',
    );
    expect(problem(capped(0))).toContain('"maxPerFile" must be a positive whole number');
    expect(problem(LOGGER.replace("  unless:", "  excuse:"))).toContain("unknown key(s) excuse");
    expect(problem(LOGGER.replace("type: pattern", "type: ast"))).toContain(
      '"type" must be pattern',
    );
    expect(problem(LOGGER.replace("files: ['cartridges/**/*.js']", "files: 3"))).toContain(
      '"files" must be a list of path globs',
    );
    expect(problem(STRICT.replace("  scope: file", "  unless: x"))).toContain(
      '"unless" excuses an "added" match only',
    );
    expect(problem(LOGGER.replace("  message: getLogger", "  note: getLogger"))).toContain(
      "unknown key(s) note",
    );
    expect(
      problem(STRICT.replace("  message: Every script opens with the use strict directive.\n", "")),
    ).toContain('"message" is needed');
    expect(problem(LOGGER.replace(/check:[\s\S]*?\n---/, "check: 3\n---"))).toContain(
      "check must be a mapping",
    );
    expect(problem(LOGGER.replace("  message: getLogger takes", "  message: ''\n  #"))).toContain(
      '"message" must be a non empty string',
    );
  });

  it("fails guidelines lint with the guideline id and the error", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/logger.md",
      LOGGER.replace(String.raw`added: 'getLogger\(`, "added: '("),
    );
    let err = "";
    const code = await runCli(["guidelines", "lint"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        err += text;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain('guideline "logger-category" check: "added" is not a valid regex');
  });
});

describe("a facts only review with a pattern check", () => {
  it("posts the pattern's findings as facts with no model call", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/logger.md", LOGGER);
    write(
      repo,
      "delta-peacock.config.yaml",
      "model:\n  provider: none\nreview:\n  target: main\n  fetchTarget: false\n",
    );
    commitAll(repo, "guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "cartridges/app/script.js", SCRIPT);
    commitAll(repo, "change");
    let calls = 0;
    const port = {
      complete: () => {
        calls += 1;
        return Promise.reject(new Error("a facts only run called a model"));
      },
    };
    await runCli(["review", "--report", "review.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
      modelPortFor: () => port,
    });
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(calls).toBe(0);
    expect(
      report.findings.map((one) => [
        `${one.file}:${String(one.line)}`,
        one.severity,
        one.kind === "violation" ? one.guidelineQuote : "",
      ]),
    ).toEqual([
      ["cartridges/app/script.js:2", "MAJOR", "getLogger takes a category as its second argument."],
      ["cartridges/app/script.js:4", "MAJOR", "getLogger takes a category as its second argument."],
    ]);
    expect(report.checks).toMatchObject({ candidates: 2, findings: 2 });
  });
});
