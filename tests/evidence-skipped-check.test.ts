import { readFileSync } from "node:fs";
import path from "node:path";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import type { ScmPort } from "../src/scm/port.js";
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
      confidence: 0.9,
    },
  ],
});

const refused = (): APICallError =>
  new APICallError({
    message: "Cannot connect to API: fetch failed",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    cause: Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    }),
  });

/** One batch answers with a finding, the other cannot reach the model, so the run falls back and asks no verdict. */
const port: ModelPort = {
  complete: (request) =>
    request.user.includes("+++ b/src/other.js")
      ? Promise.reject(refused())
      : Promise.resolve({ text: REVIEW }),
};

interface Run {
  out: string;
  summary: string;
  report: ReviewReport;
}

async function review(posting: string): Promise<Run> {
  const cwd = makeRepo();
  write(cwd, "guidelines/guard.md", GUARD);
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
      "  maxFilesPerBatch: 1",
      `  posting: ${posting}`,
      "fallback:",
      "  outage: fallback",
      "",
    ].join("\n"),
  );
  commitAll(cwd, "rules");
  git(cwd, "checkout", "-q", "-b", "feature");
  write(cwd, "src/app.js", "function greet(name) {\n  return name.length;\n}\n");
  write(cwd, "src/other.js", "function size(item) {\n  return item.size;\n}\n");
  commitAll(cwd, "change");
  const summary: string[] = [];
  const scm: ScmPort = {
    listInlineComments: () => Promise.resolve([]),
    createInlineComment: () => Promise.resolve(),
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
  await runCli(["review", "--report", "r.json"], {
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
    modelPort: port,
    scmPort: scm,
    wait: () => Promise.resolve(),
  });
  const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
  return { out, summary: summary.join("\n"), report };
}

describe("a model finding whose exclusion check was skipped", () => {
  it("posts under the default posting rule, as before", async () => {
    const { report } = await review("confidence");
    expect(report.findings.map((finding) => finding.title)).toEqual(["Read before a null check"]);
  });

  it("is held under posting: evidence, since no verdict cleared it, and counted under that reason, never the confidence floor", async () => {
    const run = await review("evidence");
    expect(run.report.findings).toEqual([]);
    expect(run.report.filtered).toEqual([
      expect.objectContaining({ title: "Read before a null check", holdReason: "unchecked" }),
    ]);
    expect(run.out).toContain("1 violation(s) held: exclusion check skipped (report only)");
    expect(run.out).not.toContain("under the confidence floor");
    expect(run.summary).toContain("1 unchecked violation (exclusion check skipped)");
    expect(run.summary).not.toContain("low-confidence");
  });
});
