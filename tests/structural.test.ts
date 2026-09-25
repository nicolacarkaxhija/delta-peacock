import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyStructural } from "../src/review/structural.js";
import type { Finding, Violation } from "../src/domain/finding.js";
import type { Guideline } from "../src/domain/guideline.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

function guideline(overrides: Partial<Guideline> = {}): Guideline {
  return {
    id: "no-const-in-loop",
    severity: "BLOCKER",
    title: "No const in loop",
    body: "A const declared directly in a loop body crashes on Rhino.",
    sourcePath: "guidelines/no-const-in-loop.md",
    languages: [],
    paths: [],
    tags: [],
    ...overrides,
  };
}

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    kind: "violation",
    guidelineId: "no-const-in-loop",
    severity: "BLOCKER",
    file: "src/app.js",
    line: 3,
    title: "const declared in a loop",
    body: "Use let instead.",
    ...overrides,
  };
}

const LOOP_SOURCE = [
  "function f() {",
  "  for (var i = 0; i < items.length; i++) {",
  "    const total = items[i];",
  "  }",
  "}",
].join("\n");

const CALLBACK_SOURCE = [
  "function f() {",
  "  items.forEach(function (item) {",
  "    const total = item;",
  "  });",
  "}",
].join("\n");

const DEFERRED_REQUIRE_SOURCE = [
  "server.replace('Show', function (req, res, next) {",
  "  const deliveryUtil = require('*/scripts/order/deliveryUtil');",
  "});",
].join("\n");

const TOP_LEVEL_REQUIRE_SOURCE = [
  "const deliveryUtil = require('*/scripts/order/deliveryUtil');",
  "module.exports = {};",
].join("\n");

function sourceOf(files: Record<string, string>): (file: string) => string | undefined {
  return (file) => files[file];
}

describe("verifyStructural: no guideline opt-in", () => {
  it("keeps a finding whose guideline carries no structural field, whatever the AST says", () => {
    const guidelinesById = new Map([[guideline().id, guideline()]]);
    const finding = violation({ line: 3 }); // sits in a callback, not a loop
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": CALLBACK_SOURCE }),
    );
    expect(result.kept).toEqual([finding]);
    expect(result.dropped).toEqual([]);
  });

  it("never checks an observation, which cites no guideline to key on", () => {
    const observation: Finding = {
      kind: "observation",
      severity: "MINOR",
      file: "src/app.js",
      line: 3,
      title: "stylistic note",
      body: "b",
    };
    const guidelinesById = new Map([
      [
        guideline({ structural: "no-declaration-in-loop" }).id,
        guideline({ structural: "no-declaration-in-loop" }),
      ],
    ]);
    const result = verifyStructural(
      [observation],
      guidelinesById,
      sourceOf({ "src/app.js": CALLBACK_SOURCE }),
    );
    expect(result.kept).toEqual([observation]);
  });
});

describe("verifyStructural: no-declaration-in-loop", () => {
  const loopGuideline = guideline({ structural: "no-declaration-in-loop" });
  const guidelinesById = new Map([[loopGuideline.id, loopGuideline]]);

  it("drops a finding whose cited line is not inside a real loop (a .forEach callback)", () => {
    const finding = violation({ line: 3 });
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": CALLBACK_SOURCE }),
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      reason: "structural:no-declaration-in-loop",
      guidelineId: "no-const-in-loop",
      title: "const declared in a loop",
      severity: "BLOCKER",
    });
    expect(result.dropped[0]?.raw).toContain("const declared in a loop");
  });

  it("keeps a finding whose cited line genuinely sits inside a real loop", () => {
    const finding = violation({ line: 3 });
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": LOOP_SOURCE }),
    );
    expect(result.kept).toEqual([finding]);
    expect(result.dropped).toEqual([]);
  });
});

describe("verifyStructural: module-scope-only", () => {
  const requireGuideline = guideline({
    id: "no-top-require",
    structural: "module-scope-only",
  });
  const guidelinesById = new Map([[requireGuideline.id, requireGuideline]]);

  it("drops a finding whose cited line sits inside a function (a deferred require)", () => {
    const finding = violation({ guidelineId: "no-top-require", line: 2 });
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": DEFERRED_REQUIRE_SOURCE }),
    );
    expect(result.kept).toEqual([]);
    expect(result.dropped[0]?.reason).toBe("structural:module-scope-only");
  });

  it("keeps a finding whose cited line is genuinely at module top level", () => {
    const finding = violation({ guidelineId: "no-top-require", line: 1 });
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": TOP_LEVEL_REQUIRE_SOURCE }),
    );
    expect(result.kept).toEqual([finding]);
  });
});

describe("verifyStructural: graceful degradation", () => {
  const loopGuideline = guideline({ structural: "no-declaration-in-loop" });
  const guidelinesById = new Map([[loopGuideline.id, loopGuideline]]);

  it("keeps a finding when the source is unreadable (cannot refute without it)", () => {
    const finding = violation({ line: 3 });
    const result = verifyStructural([finding], guidelinesById, () => undefined);
    expect(result.kept).toEqual([finding]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps a finding when the source does not parse", () => {
    const finding = violation({ line: 3 });
    const result = verifyStructural(
      [finding],
      guidelinesById,
      sourceOf({ "src/app.js": "function f( { const x = ;;;" }),
    );
    expect(result.kept).toEqual([finding]);
  });

  it("keeps a finding citing a guideline id absent from the map (nothing to key the check on)", () => {
    const finding = violation({ guidelineId: "unknown-rule", line: 3 });
    const result = verifyStructural(
      [finding],
      new Map(),
      sourceOf({ "src/app.js": CALLBACK_SOURCE }),
    );
    expect(result.kept).toEqual([finding]);
  });
});

describe("verifyStructural: independent per finding", () => {
  it("evaluates two findings on the same file at different lines independently", () => {
    const loopGuideline = guideline({ structural: "no-declaration-in-loop" });
    const guidelinesById = new Map([[loopGuideline.id, loopGuideline]]);
    const source = [
      "function f() {",
      "  for (var i = 0; i < n; i++) {",
      "    const inLoop = i;",
      "  }",
      "  items.forEach(function (item) {",
      "    const inCallback = item;",
      "  });",
      "}",
    ].join("\n");
    const inLoop = violation({ line: 3, title: "flag a" });
    const inCallback = violation({ line: 6, title: "flag b" });
    const result = verifyStructural(
      [inLoop, inCallback],
      guidelinesById,
      sourceOf({ "src/app.js": source }),
    );
    expect(result.kept).toEqual([inLoop]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.title).toBe("flag b");
  });
});

describe("structural verification wired into a live review", () => {
  const GUIDELINE = `---
id: no-const-in-loop
severity: BLOCKER
structural: no-declaration-in-loop
---
# No const in loop

A const declared directly in a loop body crashes on Rhino.
`;

  function scriptedModel(text: string): ModelPort {
    const requests: ModelRequest[] = [];
    return {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text });
      },
    };
  }

  async function reviewWith(
    source: string,
    findingLine: number,
  ): Promise<{ code: number; report: ReviewReport; stdout: string }> {
    const repo = makeRepo();
    write(repo, "guidelines/no-const-in-loop.md", GUIDELINE);
    commitAll(repo, "add guideline");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", source);
    commitAll(repo, "change app.js");

    const reply = JSON.stringify({
      findings: [
        {
          guidelineId: "no-const-in-loop",
          file: "src/app.js",
          line: findingLine,
          title: "const declared in a loop",
          body: "Use let instead.",
          guidelineQuote: "A const declared directly in a loop body crashes on Rhino.",
        },
      ],
    });
    let stdout = "";
    const code = await runCli(["review", "--report", "review.json", "--fail-on", "BLOCKER"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: scriptedModel(reply),
    });
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    return { code, report, stdout };
  }

  it("drops a violation the model mis-structured as a loop, and the gate passes", async () => {
    const source = [
      "function addProducts(items) {",
      "  items.forEach(function (item) {",
      "    const total = item.total;",
      "  });",
      "}",
      "",
    ].join("\n");
    const { code, report, stdout } = await reviewWith(source, 3);
    expect(code).toBe(0); // the only violation was structurally refuted
    expect(report.findings).toEqual([]);
    expect(report.droppedStructuralFindings).toBe(1);
    expect(stdout).toContain("1 finding(s) dropped: structural claim contradicted by the AST");
  });

  it("keeps a genuine violation whose cited line is really inside a loop, and the gate fails", async () => {
    const source = [
      "function addProducts(items) {",
      "  for (var i = 0; i < items.length; i++) {",
      "    const total = items[i].total;",
      "  }",
      "}",
      "",
    ].join("\n");
    const { code, report } = await reviewWith(source, 3);
    expect(code).toBe(2); // BLOCKER severity fails the default gate
    expect(report.findings).toHaveLength(1);
    expect(report.droppedStructuralFindings).toBe(0);
  });
});
