import { describe, expect, it } from "vitest";
import type { Violation } from "../src/domain/finding.js";
import { publishReview, renderSummaryBody } from "../src/scm/publish.js";
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

describe("comment rendering", () => {
  it("labels observation comments distinctly", async () => {
    const { renderCommentBody } = await import("../src/scm/publish.js");
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
    expect(body).toContain("observation (general pass)");
    expect(body).toContain("<!-- delta-peacock:finding:abcdef123456 -->");
  });
});

describe("summary rendering", () => {
  it("shows a failed gate with its threshold and count", () => {
    const body = renderSummaryBody({
      findings: [violation()],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { threshold: "MAJOR", failing: 1, failed: true },
    });
    expect(body).toContain("failOn=MAJOR FAILED (1)");
    expect(body).toContain("| MAJOR | 1 |");
  });

  it("shows a passed gate", () => {
    const body = renderSummaryBody({
      findings: [violation({ severity: "INFO" })],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { threshold: "MAJOR", failing: 0, failed: false },
    });
    expect(body).toContain("failOn=MAJOR passed");
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
    expect(body).toContain("`no-magic` (MINOR): recurring");
    expect(body).toContain("1 finding(s) under the confidence floor");
    expect(body).toContain("2 uncited finding(s) dropped");
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
