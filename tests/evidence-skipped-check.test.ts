import { readFileSync } from "node:fs";
import path from "node:path";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
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

async function review(posting: string): Promise<ReviewReport> {
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
  await runCli(["review", "--report", "r.json"], {
    cwd,
    env: {},
    out: () => undefined,
    err: () => undefined,
    modelPort: port,
  });
  return JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
}

describe("a model finding whose exclusion check was skipped", () => {
  it("posts under the default posting rule, as before", async () => {
    const report = await review("confidence");
    expect(report.findings.map((finding) => finding.title)).toEqual(["Read before a null check"]);
  });

  it("is held under posting: evidence, since no verdict cleared it", async () => {
    const report = await review("evidence");
    expect(report.findings).toEqual([]);
    expect(report.filtered.map((finding) => finding.title)).toEqual(["Read before a null check"]);
  });
});
