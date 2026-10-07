import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import type { Guideline } from "../src/domain/guideline.js";
import { parseGuidelineContent } from "../src/guidelines/loader.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { applyExclusions } from "../src/review/exclusions.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const EXCLUSION = "A value the function receives as a parameter is never a finding.";

const GUARD = `---
id: guard-before-use
severity: MAJOR
exclusions:
  - ${EXCLUSION}
---
# Guard a value before use

Check a value for null before reading a property of it. ${EXCLUSION}
`;

function guideline(content: string): Guideline {
  const parsed = parseGuidelineContent(content, "guidelines/guard.md");
  if (!("guideline" in parsed)) throw new Error(JSON.stringify(parsed));
  return parsed.guideline;
}

function problem(content: string): string {
  const parsed = parseGuidelineContent(content, "guidelines/guard.md");
  return "problem" in parsed ? parsed.problem : "";
}

const FINDING: Finding = {
  kind: "violation",
  guidelineId: "guard-before-use",
  severity: "MAJOR",
  file: "src/app.js",
  line: 2,
  title: "Read before a null check",
  body: "name is read without a guard.",
};

/** A port that answers every request with the next reply, and keeps what it was asked. */
function scripted(...replies: string[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const text = replies[Math.min(requests.length - 1, replies.length - 1)] ?? "";
        return Promise.resolve({ text, usage: { inputTokens: 100, outputTokens: 10 } });
      },
    },
  };
}

const verdict = (value: object): string => JSON.stringify(value);

function options(port: ModelPort, rule: Guideline = guideline(GUARD)) {
  return {
    port: () => port,
    guidelinesById: new Map([[rule.id, rule]]),
    linesOf: () => ["function greet(name) {", "  return name.length;", "}"],
    concurrency: 2,
  };
}

describe("exclusions in the guideline frontmatter", () => {
  it("reads the sentences the guideline says", () => {
    expect(guideline(GUARD).exclusions).toEqual([EXCLUSION]);
  });

  it("refuses a sentence the guideline does not say word for word", () => {
    const changed = GUARD.replace(`  - ${EXCLUSION}`, "  - A constant is never a finding here.");
    expect(problem(changed)).toContain("must be a sentence the guideline says word for word");
  });

  it("refuses anything but a list of sentences", () => {
    expect(problem(GUARD.replace(`  - ${EXCLUSION}`, "  - 3"))).toContain(
      "must be a list of sentences",
    );
  });
});

describe("the exclusion check", () => {
  it("drops a finding the judge excludes by copying a listed case", async () => {
    const { port, requests } = scripted(
      verdict({ verdict: "excluded", exclusion: EXCLUSION, reason: "name is a parameter" }),
    );
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([]);
    expect(outcome.dropped[0]).toMatchObject({
      reason: "excluded",
      guidelineId: "guard-before-use",
    });
    expect(requests[0]?.user).toContain(`- ${EXCLUSION}`);
    expect(requests[0]?.user).toContain(">>   2|   return name.length;");
    expect(outcome.usage?.inputTokens).toBe(100);
  });

  it("keeps a finding the judge says stands", async () => {
    const { port } = scripted(verdict({ verdict: "stands", reason: "no listed case" }));
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.dropped).toEqual([]);
  });

  it("keeps a finding excluded on a case the guideline does not list", async () => {
    const { port } = scripted(
      verdict({ verdict: "excluded", exclusion: "Template conditions are presentation." }),
    );
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
  });

  it("asks once more after an unreadable reply, then keeps the finding", async () => {
    const { port, requests } = scripted("no json here");
    const outcome = await applyExclusions([FINDING], options(port));
    expect(requests).toHaveLength(2);
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.notices[0]).toContain("no verdict");
  });

  it("keeps the finding when the call fails", async () => {
    const port: ModelPort = { complete: () => Promise.reject(new Error("connection reset")) };
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.notices[0]).toContain("connection reset");
  });

  it("makes no call for a guideline that lists no exclusions", async () => {
    const plain = guideline(GUARD.replace(`exclusions:\n  - ${EXCLUSION}\n`, ""));
    const { port, requests } = scripted("{}");
    const outcome = await applyExclusions([FINDING], options(port, plain));
    expect(requests).toHaveLength(0);
    expect(outcome.kept).toEqual([FINDING]);
  });
});

describe("a review with an excluded finding", () => {
  function repo(): string {
    const cwd = makeRepo();
    write(cwd, "guidelines/guard.md", GUARD);
    commitAll(cwd, "rules");
    git(cwd, "checkout", "-q", "-b", "feature");
    write(cwd, "src/app.js", "function greet(name) {\n  return name.length;\n}\n");
    commitAll(cwd, "change");
    return cwd;
  }

  const REVIEW = JSON.stringify({
    findings: [
      {
        guidelineId: "guard-before-use",
        file: "src/app.js",
        line: 2,
        quote: "  return name.length;",
        guidelineQuote: "Check a value for null before reading a property of it.",
        title: "Read before a null check",
        body: "name is read without a guard.",
      },
    ],
  });

  async function review(judged: string): Promise<{ code: number; report: ReviewReport }> {
    const cwd = repo();
    const port: ModelPort = {
      complete(request) {
        const text = request.system.includes("exclusion check") ? judged : REVIEW;
        return Promise.resolve({ text });
      },
    };
    const code = await runCli(["review", "--report", "r.json", "--fail-on", "MAJOR"], {
      cwd,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
    return { code, report };
  }

  it("posts nothing and passes the gate when the guideline excludes the line", async () => {
    const { code, report } = await review(verdict({ verdict: "excluded", exclusion: EXCLUSION }));
    expect(code).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.rejectedCandidates?.map((one) => one.reason)).toContain("excluded");
  });

  it("keeps the finding and gates when no listed case covers it", async () => {
    const { code, report } = await review(verdict({ verdict: "stands" }));
    expect(code).toBe(2);
    expect(report.findings).toHaveLength(1);
  });
});
