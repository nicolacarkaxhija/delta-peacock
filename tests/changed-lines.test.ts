import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding, Violation } from "../src/domain/finding.js";
import { parseGuidelineContent } from "../src/guidelines/loader.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { keepOnChangedLines } from "../src/review/changed-lines.js";
import type { ReviewReport } from "../src/review/report.js";
import { renderSummaryBody } from "../src/scm/comment-format.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const RULE = `---
id: guard-before-use
severity: MAJOR
---
# Guard a value before use

Check a value for null before reading a property of it.
`;

const ON_ADDED: Violation = {
  kind: "violation",
  guidelineId: "guard-before-use",
  severity: "MAJOR",
  file: "src/app.js",
  line: 2,
  title: "Read before a null check",
  body: "name is read without a guard.",
  quote: "  return name.length;",
};

const ON_CONTEXT: Violation = { ...ON_ADDED, line: 1, quote: "function greet(name) {" };

const ADDED = new Map([["src/app.js", new Map([[2, "  return name.length;"]])]]);

describe("findings on changed lines only", () => {
  const rules = new Map([["guard-before-use", {}]]);

  it("drops a finding on a hunk context line and keeps one on an added line", () => {
    const outcome = keepOnChangedLines([ON_ADDED, ON_CONTEXT], ADDED, rules);
    expect(outcome.kept).toEqual([ON_ADDED]);
    expect(outcome.dropped).toEqual([
      expect.objectContaining({ reason: "off-change", guidelineId: "guard-before-use" }),
    ]);
  });

  it("keeps a finding whose quoted span reaches an added line", () => {
    const spanning = { ...ON_CONTEXT, quote: "function greet(name) {\n  return name.length;" };
    expect(keepOnChangedLines([spanning], ADDED, rules).kept).toEqual([spanning]);
  });

  it("drops a finding in a file the change does not touch", () => {
    const elsewhere = { ...ON_ADDED, file: "src/other.js" };
    expect(keepOnChangedLines([elsewhere], ADDED, rules).dropped).toHaveLength(1);
  });

  it("keeps a finding under a guideline that declares file scope", () => {
    const fileWide = new Map([["guard-before-use", { scope: "file" as const }]]);
    expect(keepOnChangedLines([ON_CONTEXT], ADDED, fileWide).kept).toEqual([ON_CONTEXT]);
  });

  it("leaves an observation and a finding with no line alone", () => {
    const observation: Finding = { ...ON_CONTEXT, kind: "observation" };
    const unplaced = { ...ON_CONTEXT, unplaced: true };
    const outcome = keepOnChangedLines([observation, unplaced], ADDED, rules);
    expect(outcome.kept).toEqual([observation, unplaced]);
  });
});

describe("the scope a guideline declares", () => {
  it("reads scope file and refuses anything but line or file", () => {
    const declared = parseGuidelineContent(RULE.replace("---\n#", "scope: file\n---\n#"), "g.md");
    expect("guideline" in declared && declared.guideline.scope).toBe("file");
    const wrong = parseGuidelineContent(RULE.replace("---\n#", "scope: hunk\n---\n#"), "g.md");
    expect("problem" in wrong && wrong.problem).toContain('"scope" must be line or file');
  });
});

describe("a review whose model flags an unchanged line", () => {
  const EXCLUSION = "A value the function receives as a parameter is never a finding.";

  function repo(rule: string): string {
    const cwd = makeRepo();
    write(cwd, "guidelines/guard.md", rule);
    commitAll(cwd, "rules");
    git(cwd, "checkout", "-q", "-b", "feature");
    write(cwd, "src/app.js", "function greet(name) {\n  return name.length;\n}\n");
    commitAll(cwd, "change");
    return cwd;
  }

  const raw = (finding: Violation) => ({
    guidelineId: finding.guidelineId,
    file: finding.file,
    line: finding.line,
    quote: finding.quote,
    guidelineQuote: "Check a value for null before reading a property of it.",
    title: finding.title,
    body: finding.body,
  });

  async function review(rule: string) {
    const cwd = repo(rule);
    const verdicts: ModelRequest[] = [];
    const port: ModelPort = {
      complete(request) {
        if (request.system.includes("exclusion check")) {
          verdicts.push(request);
          return Promise.resolve({
            text: JSON.stringify({ verdict: "stands", exclusion: "none" }),
          });
        }
        const findings = [raw(ON_ADDED), raw(ON_CONTEXT)];
        return Promise.resolve({ text: JSON.stringify({ findings }) });
      },
    };
    const out: string[] = [];
    await runCli(["review", "--report", "r.json"], {
      cwd,
      env: {},
      out: (text) => out.push(text),
      err: () => undefined,
      modelPort: port,
    });
    const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
    return { report, out: out.join(""), verdicts };
  }

  it("publishes only the finding on the edited line and counts the other", async () => {
    const { report, out } = await review(RULE);
    expect(report.findings.map((finding) => finding.line)).toEqual([2]);
    expect(report.droppedOffChangeFindings).toBe(1);
    expect(report.rejectedCandidates?.map((one) => one.reason)).toContain("off-change");
    expect(out).toContain("1 finding(s) off the change");
  });

  it("drops it before the exclusion check spends a call on it", async () => {
    const listed = RULE.replace("---\n#", `exclusions:\n  - ${EXCLUSION}\n---\n#`).replace(
      "of it.",
      `of it. ${EXCLUSION}`,
    );
    const { verdicts } = await review(listed);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.user).toContain("src/app.js:2");
  });
});

describe("the summary comment", () => {
  it("names the findings off the change among those not posted", () => {
    const body = renderSummaryBody({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      droppedOffChange: 4,
      filtered: 0,
      gate: { threshold: "none", failing: 0, failed: false },
    });
    expect(body).toContain("_Not posted: 4 findings off the change._");
  });
});
