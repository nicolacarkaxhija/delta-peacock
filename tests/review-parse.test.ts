import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { ToolError } from "../src/errors.js";
import { parseReviewResponse } from "../src/review/parse.js";
import { buildReviewPrompt } from "../src/review/prompt.js";

const guideline: Guideline = {
  id: "no-console",
  severity: "MAJOR",
  title: "No console statements",
  body: "Use the logger instead.",
  sourcePath: "guidelines/no-console.md",
};

const byId = new Map([[guideline.id, guideline]]);

function response(findings: unknown[]): string {
  return JSON.stringify({ findings });
}

const finding = {
  guidelineId: "no-console",
  file: "src/app.js",
  line: 2,
  title: "Console call",
  body: "Replace with the logger.",
};

describe("parseReviewResponse", () => {
  it("maps cited findings to violations inheriting the guideline severity", () => {
    const { violations, droppedUncited } = parseReviewResponse(response([finding]), byId);
    expect(droppedUncited).toBe(0);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "violation",
      guidelineId: "no-console",
      severity: "MAJOR",
      file: "src/app.js",
      line: 2,
    });
  });

  it("drops and counts findings citing unknown guidelines", () => {
    const { violations, droppedUncited } = parseReviewResponse(
      response([finding, { ...finding, guidelineId: "invented-rule" }]),
      byId,
    );
    expect(violations).toHaveLength(1);
    expect(droppedUncited).toBe(1);
  });

  it("tolerates a fenced JSON response", () => {
    const fenced = "```json\n" + response([finding]) + "\n```";
    expect(parseReviewResponse(fenced, byId).violations).toHaveLength(1);
  });

  it("tolerates prose around the JSON object", () => {
    const wrapped = `Here is my review:\n${response([finding])}\nHope that helps!`;
    expect(parseReviewResponse(wrapped, byId).violations).toHaveLength(1);
  });

  it("falls back to the guideline title and line 1 on sloppy fields", () => {
    const sloppy = response([{ guidelineId: "no-console", file: "src/app.js", line: -5 }]);
    const { violations } = parseReviewResponse(sloppy, byId);
    expect(violations[0]).toMatchObject({ line: 1, title: "No console statements" });
  });

  it.each([
    { name: "no JSON at all", text: "I could not review this." },
    { name: "reversed braces", text: "} nothing here {" },
    { name: "broken JSON", text: '{"findings": [' },
    { name: "wrong shape", text: '{"findings": "yes"}' },
  ])("throws a ToolError on $name", ({ text }) => {
    expect(() => parseReviewResponse(text, byId)).toThrow(ToolError);
  });

  it("accepts an empty findings response", () => {
    const parsed = parseReviewResponse(response([]), byId);
    expect(parsed.violations).toEqual([]);
    expect(parsed.droppedUncited).toBe(0);
  });
});

describe("rendering and reporting edges", () => {
  it("renders a violation without a body on a single line", async () => {
    const { renderReview } = await import("../src/review/render.js");
    const text = renderReview({
      violations: [
        {
          kind: "violation",
          guidelineId: "no-console",
          severity: "MAJOR",
          file: "a.js",
          line: 1,
          title: "t",
          body: "",
        },
      ],
      droppedUncited: 0,
      gate: { threshold: "none", failing: 0, failed: false },
    });
    expect(text).toContain("[no-console] t");
    expect(text).not.toContain("         \n");
  });

  it("builds a report without usage when none was measured", async () => {
    const { buildReport } = await import("../src/review/report.js");
    const report = buildReport({
      violations: [],
      droppedUncited: 0,
      gate: { threshold: "none", failing: 0, failed: false },
    });
    expect("usage" in report).toBe(false);
  });

  it("normalizes missing token counts to zero", async () => {
    const { normalizeUsage } = await import("../src/model/anthropic.js");
    expect(normalizeUsage({ inputTokens: undefined, outputTokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
    });
    expect(normalizeUsage({ inputTokens: 3, outputTokens: undefined })).toEqual({
      inputTokens: 3,
      outputTokens: 0,
    });
  });
});

describe("buildReviewPrompt", () => {
  it("carries guidelines in the system prompt and the fenced diff in the user prompt", () => {
    const request = buildReviewPrompt([guideline], "diff --git a/x b/x\n+console.log(1)\n");
    expect(request.system).toContain("no-console");
    expect(request.system).toContain("MAJOR");
    expect(request.system).toContain("Use the logger instead.");
    expect(request.user).toContain("<diff>");
    expect(request.user).toContain("console.log(1)");
    expect(request.user).toContain("untrusted");
  });
});
