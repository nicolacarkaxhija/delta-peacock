import { describe, expect, it } from "vitest";
import type { HoldCounts } from "../src/domain/hold.js";
import type { InsightReport, ScmPort } from "../src/scm/port.js";
import { publishReview } from "../src/scm/publish.js";

interface Published {
  summary: string[];
  insights: InsightReport[];
}

const HEAD = "c".repeat(40);

async function publishOnCard(filtered: number, holds?: HoldCounts): Promise<Published> {
  const published: Published = { summary: [], insights: [] };
  const scm: ScmPort = {
    listInlineComments: () => Promise.resolve([]),
    createInlineComment: () => Promise.resolve(),
    updateComment: () => Promise.resolve(),
    deleteComment: () => Promise.resolve(),
    listSummaryComments: () => Promise.resolve([]),
    createSummaryComment: (body) => {
      published.summary.push(body);
      return Promise.resolve();
    },
    updateSummaryComment: () => Promise.resolve(),
    postStatus: () => Promise.resolve(),
    publishInsights: (report) => {
      published.insights.push(report);
      return Promise.resolve();
    },
  };
  await publishReview(scm, {
    findings: [],
    proposals: [],
    droppedUncited: 0,
    filtered,
    ...(holds !== undefined ? { holds } : {}),
    gate: { threshold: "MAJOR", failing: 0, failed: false },
    reviewedCommit: HEAD,
    scope: { changed: 1, outsideInclude: 0, excluded: [] },
    commitStatus: true,
    comments: true,
    codeInsights: true,
    dryRun: false,
  });
  return published;
}

describe("a run on a Code Insights host whose only findings are held", () => {
  it("keeps the held count in the summary and on the card, which still passes", async () => {
    const { summary, insights } = await publishOnCard(1, { unplaced: 1 });
    expect(summary.join("\n")).toContain("_Not posted: 1 unplaced violation._");
    expect(insights.map((report) => report.result)).toEqual(["PASSED"]);
    expect(insights[0]?.details).toContain("Not posted: 1 unplaced violation");
  });

  it("names each hold reason on the card, the floor included", async () => {
    const { insights } = await publishOnCard(3, { unchecked: 2 });
    expect(insights[0]?.details).toContain(
      "Not posted: 1 low-confidence finding, 2 unchecked violations (exclusion check skipped)",
    );
  });

  it("stays a quiet line and a clean card when nothing at all is held", async () => {
    const { summary, insights } = await publishOnCard(0);
    expect(summary).toHaveLength(1);
    expect(summary[0]).not.toContain("Not posted");
    expect(summary[0]?.split("\n")[0]).toMatch(/^No issues found in this change/);
    expect(insights.map((report) => report.result)).toEqual(["PASSED"]);
    expect(insights[0]?.details).not.toContain("Not posted");
  });
});
