import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ReviewReport } from "../src/review/report.js";
import type { ScmPort } from "../src/scm/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const RULE = `---
id: guard-before-use
severity: MAJOR
languages: [javascript]
paths: ["**/*.js"]
---
# Guard a value before use

Check a value for null before reading a property of it.
`;

/** The quote names a line the file does not hold, so the finding cannot be placed. */
const UNPLACED = {
  guidelineId: "guard-before-use",
  file: "src/greet.js",
  line: 1,
  quote: "  return person.nickname.length;",
  guidelineQuote: "Check a value for null before reading a property of it.",
  title: "Read before a null check",
  body: "The value is read without a guard.",
  confidence: 0.9,
};

/** The quote is the line the file holds, so the finding is placed there. */
const PLACED = {
  ...UNPLACED,
  line: 2,
  quote: "  return name.length;",
  title: "Length read before a null check",
};

interface Run {
  code: number;
  out: string;
  inline: string[];
  summary: string[];
  report: ReviewReport;
}

async function review(posting: string, findings: object[]): Promise<Run> {
  const cwd = makeRepo();
  write(cwd, "guidelines/guard.md", RULE);
  write(
    cwd,
    "delta-peacock.config.yaml",
    [
      "model:",
      "  provider: anthropic",
      "  id: some-model",
      "review:",
      "  target: main",
      "  fetchTarget: false",
      "  generalPass: false",
      ...(posting === "unset" ? [] : [`  posting: ${posting}`]),
      "gate:",
      "  failOn: MAJOR",
      "",
    ].join("\n"),
  );
  commitAll(cwd, "rules");
  git(cwd, "checkout", "-q", "-b", "feature");
  write(cwd, "src/greet.js", "function greet(name) {\n  return name.length;\n}\n");
  commitAll(cwd, "change");
  const inline: string[] = [];
  const summary: string[] = [];
  const scm: ScmPort = {
    listInlineComments: () => Promise.resolve([]),
    createInlineComment: (comment) => {
      inline.push(comment.body);
      return Promise.resolve();
    },
    updateComment: () => Promise.resolve(),
    deleteComment: () => Promise.resolve(),
    listSummaryComments: () => Promise.resolve([]),
    createSummaryComment: (body) => {
      summary.push(body);
      return Promise.resolve();
    },
    updateSummaryComment: () => Promise.resolve(),
    postStatus: () => Promise.resolve(),
  };
  let out = "";
  const code = await runCli(["review", "--report", "r.json"], {
    cwd,
    env: {
      DELTA_PEACOCK_SCM_PROVIDER: "github",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    },
    out: (text) => {
      out += text;
    },
    err: () => undefined,
    modelPort: { complete: () => Promise.resolve({ text: JSON.stringify({ findings }) }) },
    scmPort: scm,
    wait: () => Promise.resolve(),
  });
  const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
  return { code, out, inline, summary, report };
}

describe("a violation whose quote matches no line of the file", () => {
  it.each([["unset"], ["confidence"], ["evidence"]])(
    "is held with posting %s: recorded with its reason, counted apart from the confidence floor, never gating",
    async (posting) => {
      const run = await review(posting, [UNPLACED]);
      expect(run.code).toBe(0);
      expect(run.inline).toEqual([]);
      expect(run.report.findings).toEqual([]);
      expect(run.report.gate.failed).toBe(false);
      expect(run.report.filtered).toEqual([expect.objectContaining({ holdReason: "unplaced" })]);
      expect(run.report.filtered.map((finding) => [finding.unplaced, finding.note])).toEqual([
        [
          true,
          "The quoted line `return person.nickname.length;` is not in `src/greet.js`, so this finding is not placed on a line.",
        ],
      ]);
      expect(run.out).toContain("1 violation(s) held: not placed on a line (report only)");
      expect(run.out).not.toContain("under the confidence floor");
      const summary = run.summary.join("\n");
      expect(summary).toContain("_Not posted: 1 unplaced violation._");
      expect(summary).not.toContain("low-confidence");
      expect(summary).not.toContain("Blocked");
    },
  );

  it.each([["unset"], ["confidence"], ["evidence"]])(
    "leaves the gate to the placed violation beside it with posting %s",
    async (posting) => {
      const run = await review(posting, [UNPLACED, PLACED]);
      expect(run.code).toBe(2);
      expect(run.report.gate.failing).toBe(1);
      expect(run.report.findings.map((finding) => [finding.line, finding.unplaced])).toEqual([
        [2, undefined],
      ]);
      expect(run.report.filtered.map((finding) => finding.holdReason)).toEqual(["unplaced"]);
      expect(run.inline).toHaveLength(1);
      const summary = run.summary.join("\n");
      expect(summary).toContain("Blocked: a major finding must be resolved");
      expect(summary).toContain("_Not posted: 1 unplaced violation._");
    },
  );
});
