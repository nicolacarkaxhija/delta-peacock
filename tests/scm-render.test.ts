import { describe, expect, it } from "vitest";
import type { Finding, Violation } from "../src/domain/finding.js";
import type { GateDecision } from "../src/domain/gate.js";
import {
  blockedLine,
  isSummaryBody,
  NOT_REVIEWED,
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
  type SummaryInput,
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
    expect(summaryOf([], PASSED)).toBe("No issues found in this change.");
  });

  it("counts, lists, and blocks with a pointer to the reviews doc", () => {
    const body = summaryOf(
      [violation(), violation({ severity: "MINOR", file: "b.js", line: 9, title: "Nit" })],
      { threshold: "MAJOR", failing: 1, failed: true },
    );
    expect(body).toBe(
      [
        "2 findings: 1 major, 1 minor",
        "",
        "- **Major** [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md) in `src/app.js` line 2: Console call",
        "- **Minor** [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md) in `b.js` line 9: Nit",
        "",
        "**Blocked: a major finding must be resolved.**",
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

  it("omits the doc pointer without a doc, and names the doc plainly where nothing links", () => {
    const noGuide: Presentation = { ...BITBUCKET_LOOK };
    delete noGuide.guidePath;
    const blocked: GateDecision = { threshold: "MAJOR", failing: 1, failed: true };
    expect(summaryOf([violation()], blocked, noGuide)).not.toContain("How reviews work");
    const noLinks: Presentation = { ...BITBUCKET_LOOK };
    delete noLinks.fileLink;
    const plain = summaryOf([violation()], blocked, noLinks);
    expect(plain).toContain(`How reviews work and how to respond: ${String(noLinks.guidePath)}`);
    expect(plain).not.toContain("](");
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
    expect(body).toBe("No issues found in this change.\n\n<!-- delta-peacock:summary -->");
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

describe("findings on an accepted form", () => {
  it("are counted first in the not posted line", () => {
    const body = renderSummaryBody({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 1,
      accepted: 2,
      gate: PASSED,
    });
    expect(body).toContain("_Not posted: 2 accepted findings, 1 low-confidence finding._");
    const one = renderSummaryBody({
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      accepted: 1,
      gate: PASSED,
    });
    expect(one).toContain("_Not posted: 1 accepted finding._");
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
      "2 findings: 1 major, 1 minor. Blocked: a major finding must be resolved.",
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

describe("the one line a clean run leaves", () => {
  const HEAD = "a".repeat(40);
  const ANCHOR = "b".repeat(40);
  const LINKED: Presentation = {
    ...BITBUCKET_LOOK,
    commitLink: (sha) => `https://bitbucket.org/acme/widgets/commits/${sha}`,
  };
  const at = (sha: string) =>
    `[${sha.slice(0, 12)}](https://bitbucket.org/acme/widgets/commits/${sha})`;

  function cleanInput(extra: object): SummaryInput {
    return Object.assign(
      { findings: [], proposals: [], droppedUncited: 0, filtered: 0, gate: PASSED },
      extra,
    );
  }

  it("names the files the scope left out, grouped by the glob that matched them", () => {
    const input = cleanInput({
      outcome: { kind: "not-reviewed", line: NOT_REVIEWED.nothingInScope },
      reviewedCommit: HEAD,
      scope: {
        changed: 3,
        outsideInclude: 0,
        excluded: [
          { glob: "**/*.xml", files: 2 },
          { glob: "docs/**", files: 1 },
        ],
      },
    });
    expect(renderSummaryBody(input, LINKED)).toBe(
      `Nothing to review in this change at ${at(HEAD)}: 3 changed files, 3 outside the guideline scope (2 \`**/*.xml\`, 1 \`docs/**\`).`,
    );
  });

  it("counts a mix of left out and reviewed files on a clean review", () => {
    const input = cleanInput({
      reviewedCommit: HEAD,
      scope: { changed: 4, outsideInclude: 1, excluded: [{ glob: "**/*.xml", files: 2 }] },
    });
    expect(renderSummaryBody(input, LINKED)).toBe(
      `No issues found in this change at ${at(HEAD)}: 4 changed files, 3 outside the guideline scope (2 \`**/*.xml\`, 1 not under \`review.include\`), 0 findings on the rest.`,
    );
  });

  it("names the commit an earlier review already covered", () => {
    const input = cleanInput({
      outcome: { kind: "not-reviewed", line: NOT_REVIEWED.nothingInScope },
      reviewedCommit: HEAD,
      scope: {
        changed: 2,
        outsideInclude: 0,
        excluded: [],
        alreadyReviewed: { files: 2, commit: ANCHOR },
      },
    });
    expect(renderSummaryBody(input, LINKED)).toBe(
      `Nothing to review in this change at ${at(HEAD)}: 2 changed files, 2 already reviewed at ${at(ANCHOR)}.`,
    );
  });

  it("says when no guideline applies to the files in scope, and when nothing changed at all", () => {
    const none = cleanInput({
      outcome: { kind: "not-reviewed", line: NOT_REVIEWED.noneApply },
      scope: { changed: 1, outsideInclude: 0, excluded: [] },
    });
    expect(renderSummaryBody(none, BITBUCKET_LOOK)).toBe(
      "Nothing to review in this change: 1 changed file, 1 with no applicable guideline.",
    );
    const empty = cleanInput({
      outcome: { kind: "not-reviewed", line: NOT_REVIEWED.nothingInScope },
      reviewedCommit: HEAD,
      scope: { changed: 0, outsideInclude: 0, excluded: [] },
    });
    expect(renderSummaryBody(empty, BITBUCKET_LOOK)).toBe(
      `Nothing to review in this change at \`${HEAD.slice(0, 12)}\`: no file changed.`,
    );
  });

  it("keeps the old line where the run knows no scope, and never touches the Insights card", () => {
    const input = cleanInput({ reviewedCommit: HEAD });
    expect(renderSummaryBody(input, LINKED)).toBe("No issues found in this change.");
    const scoped = cleanInput({
      reviewedCommit: HEAD,
      scope: { changed: 1, outsideInclude: 0, excluded: [] },
    });
    expect(buildInsightReport(scoped, LINKED).details).toBe("No issues found in this change.");
  });

  it("leaves every other outcome its own line", () => {
    const scope = { changed: 2, outsideInclude: 0, excluded: [] };
    const large = cleanInput({
      outcome: { kind: "not-reviewed", line: NOT_REVIEWED.tooLarge },
      reviewedCommit: HEAD,
      scope,
    });
    expect(renderSummaryBody(large, LINKED)).toBe(NOT_REVIEWED.tooLarge);
    const failed = cleanInput({
      outcome: { kind: "failed", reason: "the model timed out" },
      reviewedCommit: HEAD,
      scope,
    });
    expect(renderSummaryBody(failed, LINKED).split("\n")[0]).toBe(
      "The review could not complete: the model timed out.",
    );
    const found = cleanInput({ reviewedCommit: HEAD, scope, findings: [violation()] });
    expect(renderSummaryBody(found, LINKED).split("\n")[0]).toBe("1 finding: 1 major");
  });

  it("recognises the new lines and the old ones as the reviewer's summary", () => {
    for (const first of [
      `No issues found in this change at ${at(HEAD)}: 1 changed file, 0 findings on the rest.`,
      "Nothing to review in this change: 2 changed files, 2 outside the guideline scope (2 `*.xml`).",
      "No issues found in this change.",
      NOT_REVIEWED.nothingInScope,
      NOT_REVIEWED.noneApply,
    ]) {
      expect(isSummaryBody(first, BITBUCKET_LOOK)).toBe(true);
    }
    expect(isSummaryBody("Nothing to review here, says a person.", BITBUCKET_LOOK)).toBe(false);
  });
});

describe("publishReview on a clean run where a card carries the result", () => {
  /** An in-memory host with a card: summary comments live in a list. */
  function cardHost(markers = false): {
    port: ScmPort;
    summaries: { id: string; body: string }[];
    edits: number;
  } {
    const state = { summaries: [] as { id: string; body: string }[], edits: 0 };
    const port: ScmPort = {
      hidesHtmlComments: markers,
      commitUrl: (sha) => `https://bitbucket.org/acme/widgets/commits/${sha}`,
      listInlineComments: () => Promise.resolve([]),
      createInlineComment: () => Promise.resolve(),
      updateComment: () => Promise.resolve(),
      deleteComment: () => Promise.resolve(),
      listSummaryComments: () => Promise.resolve(state.summaries.map((one) => ({ ...one }))),
      createSummaryComment: (body) => {
        state.summaries.push({ id: String(state.summaries.length + 1), body });
        return Promise.resolve();
      },
      updateSummaryComment: (id, body) => {
        const found = state.summaries.find((one) => one.id === id);
        if (found !== undefined) found.body = body;
        state.edits += 1;
        return Promise.resolve();
      },
      postStatus: () => Promise.resolve(),
      publishInsights: () => Promise.resolve(),
    };
    return {
      port,
      get summaries() {
        return state.summaries;
      },
      get edits() {
        return state.edits;
      },
    };
  }

  function cleanRun(commit: string): Parameters<typeof publishReview>[1] {
    return Object.assign(
      {
        findings: [],
        proposals: [{ id: "no-magic", severity: "MINOR" as const, rationale: "recurring" }],
        droppedUncited: 0,
        filtered: 1,
        gate: PASSED,
        commitStatus: true,
        comments: true,
        codeInsights: true,
        dryRun: false,
        reviewedCommit: commit,
      },
      { scope: { changed: 2, outsideInclude: 0, excluded: [{ glob: "**/*.xml", files: 1 }] } },
    );
  }

  it("posts one line once, then edits it in place on every later push", async () => {
    const host = cardHost();
    await publishReview(host.port, cleanRun("1".repeat(40)));
    expect(host.summaries).toHaveLength(1);
    expect(host.summaries[0]?.body).toBe(
      `No issues found in this change at [111111111111](https://bitbucket.org/acme/widgets/commits/${"1".repeat(40)}): 2 changed files, 1 outside the guideline scope (1 \`**/*.xml\`), 0 findings on the rest.`,
    );
    await publishReview(host.port, cleanRun("2".repeat(40)));
    expect(host.summaries).toHaveLength(1);
    expect(host.summaries[0]?.body).toContain("at [222222222222](");
    expect(host.edits).toBe(1);
    await publishReview(host.port, cleanRun("2".repeat(40)));
    expect(host.edits).toBe(1);
  });

  it("posts the full template when a finding was accepted, so the count shows", async () => {
    const host = cardHost();
    await publishReview(host.port, { ...cleanRun("1".repeat(40)), accepted: 2 });
    expect(host.summaries[0]?.body).toContain(
      "_Not posted: 2 accepted findings, 1 low-confidence finding._",
    );
  });

  it("keeps the marker under the line where the host hides it", async () => {
    const host = cardHost(true);
    await publishReview(host.port, cleanRun("1".repeat(40)));
    expect(host.summaries[0]?.body).toMatch(
      /^No issues found in this change at \[111111111111\]\([^)]+\): .+\.\n\n<!-- delta-peacock:summary -->$/,
    );
  });

  it("posts the full template when summaryWhenClean asks for it", async () => {
    const host = cardHost();
    await publishReview(host.port, { ...cleanRun("1".repeat(40)), summaryWhenClean: true });
    expect(host.summaries[0]?.body).toContain("### Proposed guidelines");
  });
});
