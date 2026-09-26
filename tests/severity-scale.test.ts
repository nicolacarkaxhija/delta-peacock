import { describe, expect, it } from "vitest";
import type { Violation } from "../src/domain/finding.js";
import { SEVERITIES, type Severity } from "../src/domain/severity.js";
import { BITBUCKET_SEVERITIES, createBitbucketPort } from "../src/scm/bitbucket.js";
import {
  blockedLine,
  countLine,
  parseFindingComment,
  severityWord,
  statusLine,
  type Presentation,
  type SummaryInput,
} from "../src/scm/comment-format.js";
import {
  buildInsightReport,
  publishReview,
  renderCommentBody,
  renderSummaryBody,
  taskContent,
} from "../src/scm/publish.js";
import { BOT_UUID, startFakeBitbucket } from "./helpers/fake-bitbucket.js";

function violation(severity: Severity, line = 2): Violation {
  return {
    kind: "violation",
    guidelineId: "prefer-test-ids",
    severity,
    file: "pages/pdp.ts",
    line,
    title: "CSS selector",
    body: "Use a test id.",
  };
}

const GITHUB: Presentation = {
  displayName: "Code review",
  markers: true,
  suggestionFence: "suggestion",
  guidelinesDir: "guidelines",
};

const BITBUCKET: Presentation = {
  ...GITHUB,
  markers: false,
  suggestionFence: "",
  severityScale: BITBUCKET_SEVERITIES,
};

// the consumer's PR 33: one MAJOR finding behind a MAJOR gate
const PR33: SummaryInput = {
  findings: [violation("MAJOR")],
  proposals: [],
  droppedUncited: 0,
  filtered: 0,
  gate: { threshold: "MAJOR", failing: 1, failed: true },
};

const REVIEW_WORDS = /\b(?:blocker|major|minor|info)\b/i;
const HOST_WORDS = /\b(?:high|medium|low)\b/i;

/** Every text a reader sees for one run. */
function surfaces(presentation: Presentation): string[] {
  const report = buildInsightReport(PR33, presentation);
  return [
    renderSummaryBody(PR33, presentation),
    statusLine(PR33, presentation),
    renderCommentBody(violation("MAJOR"), "abc", presentation),
    taskContent(violation("MAJOR"), "abc", "12345678", presentation),
    report.details,
    ...report.counts.map((count) => count.label),
  ];
}

describe("severity scale", () => {
  it("maps the review scale onto Bitbucket's four annotation severities", () => {
    expect(BITBUCKET_SEVERITIES).toEqual({
      BLOCKER: "CRITICAL",
      CRITICAL: "CRITICAL",
      MAJOR: "HIGH",
      MINOR: "MEDIUM",
      INFO: "LOW",
    });
    expect(SEVERITIES.map((severity) => severityWord(severity, BITBUCKET))).toEqual([
      "Critical",
      "Critical",
      "High",
      "Medium",
      "Low",
    ]);
  });

  it("speaks Bitbucket's words everywhere on Bitbucket", () => {
    expect(buildInsightReport(PR33, BITBUCKET).details).toBe(
      "1 finding: 1 high. Blocked: a high finding must be resolved.",
    );
    expect(renderSummaryBody(PR33, BITBUCKET).split("\n")[0]).toBe("1 finding: 1 high");
    expect(renderSummaryBody(PR33, BITBUCKET)).toContain(
      "- **High** `prefer-test-ids` in `pages/pdp.ts` line 2",
    );
    expect(statusLine(PR33, BITBUCKET)).toBe("1 finding, 1 high. See the comments.");
    expect(renderCommentBody(violation("MAJOR"), "abc", BITBUCKET).split("\n")[0]).toBe(
      "**High** · `prefer-test-ids`",
    );
    expect(buildInsightReport(PR33, BITBUCKET).counts).toEqual([
      { label: "Findings", value: 1 },
      { label: "High", value: 1 },
    ]);
    for (const text of surfaces(BITBUCKET)) expect(text).not.toMatch(REVIEW_WORDS);
  });

  it("keeps the review scale where the host has none", () => {
    expect(buildInsightReport(PR33, GITHUB).details).toBe(
      "1 finding: 1 major. Blocked: a major finding must be resolved.",
    );
    expect(statusLine(PR33, GITHUB)).toBe("1 finding, 1 major. See the comments.");
    expect(renderCommentBody(violation("MAJOR"), "abc", GITHUB).split("\n")[0]).toBe(
      "**Major** · `prefer-test-ids`",
    );
    for (const text of surfaces(GITHUB)) expect(text).not.toMatch(HOST_WORDS);
  });

  it("counts review severities a host merges once, most severe first", () => {
    const findings = [violation("MINOR", 1), violation("CRITICAL", 3), violation("BLOCKER", 4)];
    expect(countLine(findings, BITBUCKET)).toBe("3 findings: 2 critical, 1 medium");
    expect(countLine(findings, GITHUB)).toBe("3 findings: 1 blocker, 1 critical, 1 minor");
    const gate = { threshold: "CRITICAL" as const, failing: 2, failed: true };
    expect(blockedLine({ findings, gate }, BITBUCKET)).toBe(
      "Blocked: 2 critical findings must be resolved",
    );
    expect(blockedLine({ findings, gate }, GITHUB)).toBe(
      "Blocked: 2 findings (1 blocker, 1 critical) must be resolved",
    );
  });

  it("picks the article for a single blocking finding", () => {
    const findings = [violation("INFO")];
    const gate = { threshold: "INFO" as const, failing: 1, failed: true };
    expect(blockedLine({ findings, gate }, GITHUB)).toBe(
      "Blocked: an info finding must be resolved",
    );
    expect(blockedLine({ findings, gate }, BITBUCKET)).toBe(
      "Blocked: a low finding must be resolved",
    );
  });

  it("reads Bitbucket headings back into the review scale", () => {
    const parsed = (word: string) => parseFindingComment(`**${word}** · \`x\`\n\nWhy.`)?.severity;
    expect(["Critical", "High", "Medium", "Low"].map(parsed)).toEqual([
      "CRITICAL",
      "MAJOR",
      "MINOR",
      "INFO",
    ]);
    expect(["Blocker", "Major", "Minor", "Info"].map(parsed)).toEqual([
      "BLOCKER",
      "MAJOR",
      "MINOR",
      "INFO",
    ]);
  });
});

describe("bitbucket adapter severity", () => {
  it("sends each annotation on Bitbucket's scale and rewrites an old heading in place", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.comments.push({
        id: 40,
        content: { raw: "**Major** · `prefer-test-ids`\n\nUse a test id." },
        inline: { path: "pages/pdp.ts", to: 2 },
        user: { uuid: BOT_UUID },
      });
      const scm = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      const findings = SEVERITIES.map((severity, index) =>
        severity === "MAJOR" ? violation(severity) : violation(severity, 10 + index),
      );
      const outcome = await publishReview(scm, {
        ...PR33,
        findings,
        commitStatus: true,
        codeInsights: true,
        dryRun: false,
      });
      expect(outcome).toMatchObject({ created: 4, updated: 1, deleted: 0 });
      expect(fake.insightAnnotations.map((annotation) => annotation.severity)).toEqual([
        "CRITICAL",
        "CRITICAL",
        "HIGH",
        "MEDIUM",
        "LOW",
      ]);
      expect(fake.comments.find((comment) => comment.id === 40)?.content.raw).toMatch(
        /^\*\*High\*\* · \[prefer-test-ids\]\(\S+\)\n\nUse a test id\.$/,
      );
      expect(fake.statuses.at(-1)?.description).toBe("5 findings, 3 high. See the comments.");
    } finally {
      await fake.close();
    }
  });
});
