import { describe, expect, it } from "vitest";
import type { Finding, Violation } from "../src/domain/finding.js";
import type { GateDecision } from "../src/domain/gate.js";
import {
  blockedLine,
  parseFindingComment,
  reviewerComment,
  twoSentences,
  type Presentation,
} from "../src/scm/comment-format.js";
import {
  buildInsightReport,
  publishReview,
  renderCommentBody,
  renderSummaryBody,
} from "../src/scm/publish.js";
import type { ScmPort } from "../src/scm/port.js";

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    kind: "violation",
    guidelineId: "no-console",
    severity: "MAJOR",
    file: "src/app.js",
    line: 2,
    title: "Console call",
    body: "Use the logger.",
    ...overrides,
  };
}

const BITBUCKET_LOOK: Presentation = {
  displayName: "Automated review",
  markers: false,
  suggestionFence: "",
  guidelinesDir: "guidelines",
  fileLink: (file) => `https://bitbucket.org/acme/widgets/src/main/${file}`,
  guidePath: "docs/reviews.md",
};

function summaryOf(
  findings: Finding[],
  gate: GateDecision,
  presentation: Presentation = BITBUCKET_LOOK,
): string {
  return renderSummaryBody(
    { findings, proposals: [], droppedUncited: 0, filtered: 0, gate },
    presentation,
  );
}

const PASSED: GateDecision = { threshold: "MAJOR", failing: 0, failed: false };

describe("comment rendering", () => {
  it("labels observation comments distinctly and keeps the marker where it hides", () => {
    const body = renderCommentBody(
      {
        kind: "observation",
        severity: "MINOR",
        file: "a.js",
        line: 1,
        title: "magic number",
        body: "extract it",
      },
      "abcdef123456",
    );
    expect(body).toBe(
      "**Minor** · observation\n\nextract it\n\n<!-- delta-peacock:finding:abcdef123456 -->",
    );
  });

  it("on bitbucket: bold severity, linked guideline, two sentences, plain fence, no marker", () => {
    const body = renderCommentBody(
      violation({
        body: "Console output leaks into production logs. Use the logger. It is configured per env.",
        suggestion: "logger.info(x);",
      }),
      "abcdef123456",
      BITBUCKET_LOOK,
    );
    expect(body).toBe(
      [
        "**Major** · [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md)",
        "",
        "Console output leaks into production logs. Use the logger.",
        "",
        "```",
        "logger.info(x);",
        "```",
      ].join("\n"),
    );
  });

  it("cites a pack guideline without a link and falls back to the title for an empty body", () => {
    const body = renderCommentBody(
      violation({ pack: "sfra", body: "", title: "Console call" }),
      "abcdef123456",
      BITBUCKET_LOOK,
    );
    expect(body).toBe("**Major** · `no-console`\n\nConsole call");
  });

  it("keeps code dots and lowercase continuations inside one sentence", () => {
    expect(twoSentences("Call foo.bar() here. e.g. like so. Third. Fourth.")).toBe(
      "Call foo.bar() here. e.g. like so. Third.",
    );
  });
});

describe("reading comments back", () => {
  it("parses the current and the pre 0.1.5 heading", () => {
    expect(parseFindingComment("**Major** · [no-console](u)\n\nUse it. More.")).toEqual({
      severity: "MAJOR",
      guidelineId: "no-console",
      title: "Use it.",
    });
    expect(parseFindingComment("**Info** · `pack-rule`\n\nWhy")).toEqual({
      severity: "INFO",
      guidelineId: "pack-rule",
      title: "Why",
    });
    expect(parseFindingComment("**Minor** · observation")).toEqual({
      severity: "MINOR",
      title: "",
    });
    expect(parseFindingComment("**MAJOR** Console call — `no-console`\n\nb")).toEqual({
      severity: "MAJOR",
      guidelineId: "no-console",
      title: "Console call",
    });
    expect(parseFindingComment("**MINOR** loose — observation (general pass)")).toEqual({
      severity: "MINOR",
      title: "loose",
    });
    expect(parseFindingComment("just a human")).toBeUndefined();
  });

  it("recognises the reviewer's comments by marker, or by author plus heading", () => {
    const heading = "**Major** · [no-console](u)\n\nWhy.";
    expect(reviewerComment({ body: heading })).toBeUndefined();
    expect(reviewerComment({ body: "**Major** loose", own: true })).toBeUndefined();
    const own = reviewerComment({ body: heading, own: true, path: "a.js", line: 2 });
    expect(own?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(reviewerComment({ body: heading, own: true })?.parsed?.guidelineId).toBe("no-console");
    expect(reviewerComment({ body: "x\n<!-- delta-peacock:finding:abc123 -->" })).toEqual({
      fingerprint: "abc123",
    });
  });
});

describe("summary rendering", () => {
  it("says so plainly when the change is clean", () => {
    expect(summaryOf([], PASSED)).toBe("## Automated review\n\nNo issues found in this change.");
  });

  it("counts, lists, and blocks with a pointer to the reviews doc", () => {
    const body = summaryOf(
      [violation(), violation({ severity: "MINOR", file: "b.js", line: 9, title: "Nit" })],
      { threshold: "MAJOR", failing: 1, failed: true },
    );
    expect(body).toBe(
      [
        "## Automated review",
        "",
        "2 findings: 1 major, 1 minor",
        "",
        "- **Major** [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md) in `src/app.js` line 2: Console call",
        "- **Minor** [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md) in `b.js` line 9: Nit",
        "",
        "**Blocked: 1 major finding must be resolved.**",
        "",
        "How reviews work and how to respond: [docs/reviews.md](https://bitbucket.org/acme/widgets/src/main/docs/reviews.md)",
      ].join("\n"),
    );
  });

  it("names every blocking severity and shows no gate line while passing", () => {
    const mixed = summaryOf(
      [violation({ severity: "CRITICAL" }), violation(), violation({ line: 5 })],
      { threshold: "MAJOR", failing: 3, failed: true },
    );
    expect(mixed).toContain("**Blocked: 3 findings (1 critical, 2 major) must be resolved.**");
    const passing = summaryOf([violation({ severity: "INFO" })], PASSED);
    expect(passing).not.toContain("Blocked");
    expect(passing).not.toContain("failOn");
  });

  it("stays sane when the gate and the findings disagree", () => {
    expect(
      blockedLine({
        findings: [violation({ severity: "INFO" })],
        gate: { threshold: "MAJOR", failing: 2, failed: true },
      }),
    ).toBe("Blocked: 2 findings must be resolved");
    expect(
      blockedLine({ findings: [], gate: { threshold: "none", failing: 0, failed: true } }),
    ).toBe(undefined);
  });

  it("omits the doc pointer when there is no doc or no link", () => {
    const noGuide: Presentation = { ...BITBUCKET_LOOK };
    delete noGuide.guidePath;
    const blocked: GateDecision = { threshold: "MAJOR", failing: 1, failed: true };
    expect(summaryOf([violation()], blocked, noGuide)).not.toContain("How reviews work");
    const noLinks: Presentation = { ...BITBUCKET_LOOK };
    delete noLinks.fileLink;
    const plain = summaryOf([violation()], blocked, noLinks);
    expect(plain).not.toContain("How reviews work");
    expect(plain).toContain("- **Major** `no-console` in");
  });

  it("keeps the marker on hosts that hide it", () => {
    const body = renderSummaryBody({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: PASSED,
    });
    expect(body).toBe(
      "## Code review\n\nNo issues found in this change.\n\n<!-- delta-peacock:summary -->",
    );
  });

  it("lists proposed guidelines and the filtering footnote", () => {
    const body = renderSummaryBody({
      findings: [],
      proposals: [{ id: "no-magic", severity: "MINOR", rationale: "recurring" }],
      droppedUncited: 2,
      filtered: 1,
      gate: { threshold: "none", failing: 0, failed: false },
    });
    expect(body).toContain("### Proposed guidelines");
    expect(body).toContain("`no-magic` (minor): recurring");
    expect(body).toContain(
      "_Not posted: 1 low-confidence finding, 2 findings citing no guideline._",
    );
  });
});

describe("code insights report", () => {
  it("titles the report with the display name and counts every severity", () => {
    const report = buildInsightReport(
      {
        findings: [violation(), violation({ severity: "MINOR", line: 4, pack: "sfra" })],
        proposals: [],
        droppedUncited: 0,
        filtered: 0,
        gate: { threshold: "MAJOR", failing: 1, failed: true },
      },
      BITBUCKET_LOOK,
    );
    expect(report.title).toBe("Automated review");
    expect(report.result).toBe("FAILED");
    expect(report.details).toBe(
      "2 findings: 1 major, 1 minor. Blocked: 1 major finding must be resolved.",
    );
    expect(report.counts).toEqual([
      { label: "Findings", value: 2 },
      { label: "Major", value: 1 },
      { label: "Minor", value: 1 },
    ]);
    expect(report.annotations[0]?.link).toBe(
      "https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md",
    );
    expect(report.annotations[1]?.link).toBeUndefined();
  });

  it("passes a clean change with a zero count", () => {
    const report = buildInsightReport({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: PASSED,
    });
    expect(report).toMatchObject({
      title: "Code review",
      result: "PASSED",
      details: "No issues found in this change.",
      counts: [{ label: "Findings", value: 0 }],
    });
  });
});

describe("publishReview dry run", () => {
  /** Every method counts a call; a dry run must never trip a single one. */
  function countingScmPort(calls: string[]): ScmPort {
    return {
      listInlineComments: () => {
        calls.push("listInlineComments");
        return Promise.resolve([]);
      },
      createInlineComment: () => {
        calls.push("createInlineComment");
        return Promise.resolve();
      },
      updateComment: () => {
        calls.push("updateComment");
        return Promise.resolve();
      },
      deleteComment: () => {
        calls.push("deleteComment");
        return Promise.resolve();
      },
      listSummaryComments: () => {
        calls.push("listSummaryComments");
        return Promise.resolve([]);
      },
      createSummaryComment: () => {
        calls.push("createSummaryComment");
        return Promise.resolve();
      },
      updateSummaryComment: () => {
        calls.push("updateSummaryComment");
        return Promise.resolve();
      },
      postStatus: () => {
        calls.push("postStatus");
        return Promise.resolve();
      },
      publishInsights: () => {
        calls.push("publishInsights");
        return Promise.resolve();
      },
    };
  }

  it("performs zero adapter writes when dryRun is true, even with a live port and every toggle on", async () => {
    const calls: string[] = [];
    const outcome = await publishReview(countingScmPort(calls), {
      findings: [violation()],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { threshold: "MAJOR", failing: 1, failed: true },
      commitStatus: true,
      comments: true,
      codeInsights: true,
      dryRun: true,
    });
    expect(calls).toEqual([]);
    expect(outcome).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      notices: [expect.stringContaining("dry run")],
    });
  });
});
