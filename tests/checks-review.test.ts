import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { trackedFiles } from "../src/review/run-review.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const PREFER = `---
id: prefer-test-ids
severity: MINOR
paths: ['pages/**']
---
# getByTestId first, then role and name, CSS last

A CSS selector carries a comment saying why nothing better exists.
`;

const CONSOLE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

const CONFIG = `review:
  target: main
  fetchTarget: false
  checks:
    prefer-test-ids: selectors
stats:
  enabled: true
cost:
  rateInputPer1M: 1
  rateOutputPer1M: 5
`;

const PAGE = [
  "export class PlpPage {",
  "  tiles(): Locator {",
  "    return this.page.locator('.tile');",
  "  }",
  "  /** The listing's banner. */",
  "  banner(): Locator {",
  "    return this.page.locator('.banner');",
  "  }",
  "}",
  "",
].join("\n");

function scenario(withConsole: boolean): string {
  const repo = makeRepo();
  write(repo, "guidelines/prefer-test-ids.md", PREFER);
  if (withConsole) write(repo, "guidelines/no-console.md", CONSOLE);
  write(repo, "delta-peacock.config.yaml", CONFIG);
  commitAll(repo, "guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "pages/plp.ts", PAGE);
  if (withConsole) {
    write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  }
  commitAll(repo, "change");
  return repo;
}

function scripted(...texts: string[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const text = texts[Math.min(requests.length - 1, texts.length - 1)] ?? "";
        return Promise.resolve({ text, usage: { inputTokens: 100, outputTokens: 20 } });
      },
    },
  };
}

async function review(repo: string, port: ModelPort): Promise<{ code: number; err: string }> {
  let err = "";
  const code = await runCli(["review", "--report", "review.json"], {
    cwd: repo,
    env: {},
    out: () => undefined,
    err: (text) => {
      err += text;
    },
    modelPort: port,
  });
  return { code, err };
}

const report = (repo: string): ReviewReport =>
  JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;

describe("a review with checked guidelines", () => {
  it("keeps checked guidelines out of the open prompt and finds them only through the check", async () => {
    const repo = scenario(true);
    const open = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 2,
          quote: "console.log(name);",
          guidelineQuote: "No console statements",
          title: "Console call",
          body: "Use the logger.",
        },
        {
          guidelineId: "prefer-test-ids",
          file: "pages/plp.ts",
          line: 1,
          quote: "export class PlpPage {",
          guidelineQuote: "A CSS selector carries a comment saying why nothing better exists.",
          title: "Invented",
          body: "Not a candidate.",
        },
      ],
    });
    const judge = JSON.stringify({
      verdict: "confirm",
      guidelineQuote: "A CSS selector carries a comment saying why nothing better exists.",
      reason: "The doc comment names the element, not why CSS",
    });
    const { port, requests } = scripted(open, judge);
    const { err } = await review(repo, port);
    // the open prompt reads the whole corpus; only the check's lines count for a checked rule
    expect(requests[0]?.system).toContain("prefer-test-ids");
    expect(requests[0]?.system).toContain("no-console");
    expect(err).toContain("1 finding(s) dropped: their guideline is checked");
    const written = report(repo);
    expect(
      written.findings.map((finding) => `${finding.file}:${String(finding.line)}`).sort(),
    ).toEqual(["pages/plp.ts:3", "pages/plp.ts:7", "src/app.js:2"]);
    expect(written.checks).toEqual({ candidates: 2, findings: 2, dropped: 0, judgeFailed: 0 });
    expect(written.rejectedCandidates?.map((entry) => entry.reason)).toContain("checked");
    expect(err).toContain("check: pages/plp.ts:3 prefer-test-ids css: finding");
    expect(err).toContain(
      "check: pages/plp.ts:7 prefer-test-ids css: finding, confirmed by the judge",
    );
  });

  it("makes no open call when every guideline is checked, and records a judge that failed twice", async () => {
    const repo = scenario(false);
    const { port, requests } = scripted("not json");
    const { err, code } = await review(repo, port);
    expect(code).toBe(0);
    expect(err).toContain("every applicable guideline is checked; no open review call");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toContain("judge");
    const written = report(repo);
    expect(written.checks).toEqual({ candidates: 2, findings: 1, dropped: 0, judgeFailed: 1 });
    const ledger = readFileSync(path.join(repo, "delta-peacock.stats.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; errors?: unknown });
    expect(ledger.find((line) => line.kind === "review")?.errors).toEqual({ judgeFailed: 1 });
  });

  it("lists tracked files for method lookups, and none outside git", () => {
    const repo = scenario(false);
    expect(trackedFiles(repo)).toContain("pages/plp.ts");
    expect(trackedFiles(path.join(repo, "..", "no-such-dir-here"))).toEqual([]);
  });
});
