import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, makeRepo, write } from "./helpers/git.js";

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

const CONSOLE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

/** A violation under each guideline and one observation, each at its own confidence. */
const port: ModelPort = {
  complete: () =>
    Promise.resolve({
      text: JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 1,
            title: "Console call",
            body: "Use the logger.",
            guidelineQuote: "Use the logger.",
            confidence: 0.1,
          },
          {
            guidelineId: "guard-before-use",
            file: "src/app.js",
            line: 2,
            title: "Read before a null check",
            body: "Guard it.",
            guidelineQuote: "Check a value for null before reading a property of it.",
            confidence: 0.9,
          },
          {
            file: "src/app.js",
            line: 3,
            severity: "MINOR",
            title: "Unclear name",
            body: "Rename it.",
            confidence: 0.2,
          },
        ],
      }),
    }),
};

async function audit(posting: string): Promise<ReviewReport> {
  const repo = makeRepo();
  write(repo, "guidelines/guard.md", GUARD);
  write(repo, "guidelines/console.md", CONSOLE);
  write(repo, "src/app.js", "console.log(item);\nreturn item.size;\nconst x = 1;\n");
  commitAll(repo, "base");
  await runCli(["audit", "--report", "audit.json"], {
    cwd: repo,
    env: { DELTA_PEACOCK_REVIEW_POSTING: posting, DELTA_PEACOCK_REVIEW_GENERAL_PASS: "true" },
    out: () => undefined,
    err: () => undefined,
    modelPort: port,
  });
  return JSON.parse(readFileSync(path.join(repo, "audit.json"), "utf8")) as ReviewReport;
}

const titles = (findings: readonly { title: string }[]) => findings.map((one) => one.title).sort();

describe("audit and the posting rule", () => {
  it("keeps what clears the confidence floor by default", async () => {
    const report = await audit("confidence");
    expect(titles(report.findings)).toEqual(["Read before a null check"]);
    expect(titles(report.filtered)).toEqual(["Console call", "Unclear name"]);
  });

  it("posts on evidence under posting: evidence and holds a violation its guideline could excuse, since audit asks no verdict", async () => {
    const report = await audit("evidence");
    expect(titles(report.findings)).toEqual(["Console call"]);
    expect(titles(report.filtered)).toEqual(["Read before a null check", "Unclear name"]);
  });
});
