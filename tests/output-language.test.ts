import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/review/prompt.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function guideline() {
  return {
    id: "no-console",
    severity: "MAJOR" as const,
    title: "No console",
    body: "Use the logger.",
    languages: [],
    paths: [],
    tags: [],
    sourcePath: "guidelines/no-console.md",
  };
}

function capture(): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({
          text: JSON.stringify({
            findings: [
              {
                guidelineId: "no-console",
                file: "src/app.js",
                line: 1,
                title: "T",
                body: "b",
                guidelineQuote: "Use the logger.",
              },
            ],
          }),
        });
      },
    },
  };
}

function reviewRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  commitAll(repo, "change");
  return repo;
}

describe("output language", () => {
  it("adds nothing to the prompt when the language is the default", () => {
    const en = buildReviewPrompt([guideline()], "+diff", { generalPass: false, language: "en" });
    const bare = buildReviewPrompt([guideline()], "+diff", { generalPass: false });
    expect(en.system).toBe(bare.system);
  });

  it("adds one stable instruction ahead of the guidelines for another language", () => {
    const it_ = buildReviewPrompt([guideline()], "+diff", { generalPass: false, language: "it" });
    expect(it_.system).toContain("language tagged it");
    // the instruction lives in the cacheable prefix, before the guidelines
    expect(it_.system.indexOf("language tagged it")).toBeLessThan(
      it_.system.indexOf("## Guidelines"),
    );
    // machine-facing fields stay English
    expect(it_.system).toContain("ids, severities and all JSON field names stay exactly");
  });

  it("passes the configured language through review without touching the schema", async () => {
    const repo = reviewRepo();
    const { requests, port } = capture();
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_LANGUAGE: "de" },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("language tagged de");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    // the report shape is unchanged: ids and severities stay machine-readable
    expect(report.findings[0]?.kind).toBe("violation");
    expect(report.findings[0]).toMatchObject({ guidelineId: "no-console", severity: "MAJOR" });
  });
});
