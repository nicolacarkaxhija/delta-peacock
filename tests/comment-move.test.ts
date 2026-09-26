import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = `---
id: prefer-test-ids
severity: MINOR
---
# getByTestId first, then role and name, CSS last

A CSS selector carries a comment saying why nothing better exists.
`;

const PAGE = [
  "export class HomePage {",
  "  // No test id on the panel; the class is the same in every language.",
  "  sizeGuidePanel() {",
  "    return this.page.locator('.size-guide-panel');",
  "  }",
  "}",
  "",
].join("\n");

describe("a finding that asks to move a reason already above the line", () => {
  it("is dropped before anything is posted, and the log says why", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/prefer-test-ids.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "pages/home.js", PAGE);
    commitAll(repo, "panel");
    const quote = "    return this.page.locator('.size-guide-panel');";
    const reply = JSON.stringify({
      findings: [
        {
          guidelineId: "prefer-test-ids",
          file: "pages/home.js",
          line: 4,
          quote,
          guidelineQuote: "A CSS selector carries a comment saying why nothing better exists.",
          title: "CSS selector needs its comment on the line",
          body: "Put the reason on the selector line.",
          suggestion: `${quote} // No test id on the panel; the class is the same in every language.`,
        },
      ],
    });
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.resolve({ text: reply }) },
    });
    expect(code).toBe(0);
    expect(stderr).toContain(
      "1 finding(s) dropped: the reason they ask for already sits above the line or on the declaration",
    );
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings).toEqual([]);
    expect(report.rejectedCandidates?.map((entry) => entry.reason)).toEqual(["comment-move"]);
  });
});
