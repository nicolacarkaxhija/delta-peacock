import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { ToolError } from "../src/errors.js";
import { parseReviewResponse, type ParseOptions } from "../src/review/parse.js";
import { buildReviewPrompt } from "../src/review/prompt.js";

const guideline: Guideline = {
  id: "no-console",
  severity: "MAJOR",
  title: "No console statements",
  body: "Use the logger instead.",
  sourcePath: "guidelines/no-console.md",
  languages: [],
  paths: [],
  tags: [],
};

function options(overrides: Partial<ParseOptions> = {}): ParseOptions {
  return {
    guidelinesById: new Map([[guideline.id, guideline]]),
    generalPass: false,
    observationSeverityCap: "MINOR",
    ...overrides,
  };
}

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
    const { findings, droppedUncited } = parseReviewResponse(response([finding]), options());
    expect(droppedUncited).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "violation",
      guidelineId: "no-console",
      severity: "MAJOR",
      file: "src/app.js",
      line: 2,
    });
  });

  it("drops and counts uncited findings when the general pass is off", () => {
    const { findings, droppedUncited } = parseReviewResponse(
      response([finding, { ...finding, guidelineId: "invented-rule" }]),
      options(),
    );
    expect(findings).toHaveLength(1);
    expect(droppedUncited).toBe(1);
  });

  it("turns uncited findings into capped observations when the general pass is on", () => {
    const uncited = {
      file: "src/app.js",
      line: 4,
      title: "SQL injection",
      body: "Interpolated query.",
      severity: "BLOCKER",
    };
    const { findings, droppedUncited } = parseReviewResponse(
      response([uncited]),
      options({ generalPass: true, observationSeverityCap: "MINOR" }),
    );
    expect(droppedUncited).toBe(0);
    expect(findings[0]).toMatchObject({
      kind: "observation",
      severity: "MINOR", // BLOCKER claim capped
      title: "SQL injection",
    });
  });

  it("labels a titleless observation and carries one without a proposal", () => {
    const { findings } = parseReviewResponse(
      response([{ file: "a.js", line: 1, body: "hm" }]),
      options({ generalPass: true }),
    );
    expect(findings[0]).toMatchObject({ kind: "observation", title: "Observation" });
    expect(findings[0]?.kind === "observation" && findings[0].proposedGuideline).toBeUndefined();
  });

  it("keeps a milder observation severity than the cap", () => {
    const uncited = { file: "a.js", line: 1, title: "nit", severity: "INFO" };
    const { findings } = parseReviewResponse(
      response([uncited]),
      options({ generalPass: true, observationSeverityCap: "MAJOR" }),
    );
    expect(findings[0]?.severity).toBe("INFO");
  });

  it("carries confidence and proposed guidelines through", () => {
    const uncited = {
      file: "a.js",
      line: 1,
      title: "magic numbers",
      confidence: 0.4,
      proposedGuideline: { id: "no-magic-numbers", severity: "MINOR", rationale: "recurring" },
    };
    const { findings } = parseReviewResponse(
      response([{ ...finding, confidence: 0.9 }, uncited]),
      options({ generalPass: true }),
    );
    expect(findings[0]?.confidence).toBe(0.9);
    const observation = findings[1];
    expect(observation?.confidence).toBe(0.4);
    expect(observation?.kind === "observation" && observation.proposedGuideline?.id).toBe(
      "no-magic-numbers",
    );
  });

  it("drops an empty suggestion string instead of rendering an empty block", () => {
    const { findings } = parseReviewResponse(
      response([
        { ...finding, suggestion: "" },
        { ...finding, line: 9, suggestion: "fixed()" },
      ]),
      options(),
    );
    expect(findings[0] && "suggestion" in findings[0]).toBe(false);
    expect(findings[1]?.suggestion).toBe("fixed()");
  });

  it("tolerates a fenced JSON response", () => {
    const fenced = "```json\n" + response([finding]) + "\n```";
    expect(parseReviewResponse(fenced, options()).findings).toHaveLength(1);
  });

  it("tolerates prose around the JSON object", () => {
    const wrapped = `Here is my review:\n${response([finding])}\nHope that helps!`;
    expect(parseReviewResponse(wrapped, options()).findings).toHaveLength(1);
  });

  it("falls back to the guideline title and line 1 on sloppy fields, counting the fix", () => {
    const sloppy = response([{ guidelineId: "no-console", file: "src/app.js", line: -5 }]);
    const { findings, adjustedLines } = parseReviewResponse(sloppy, options());
    expect(findings[0]).toMatchObject({ line: 1, title: "No console statements" });
    expect(adjustedLines).toBe(1);
  });

  it("recovers the JSON when a chatty response holds several fenced blocks", () => {
    const chatty = ["```md", "some notes", "```", "and the result:", response([finding])].join(
      "\n",
    );
    expect(parseReviewResponse(chatty, options()).findings).toHaveLength(1);
  });

  it.each([
    { name: "no JSON at all", text: "I could not review this." },
    { name: "reversed braces", text: "} nothing here {" },
    { name: "broken JSON", text: '{"findings": [' },
    { name: "wrong shape", text: '{"findings": "yes"}' },
  ])("throws a ToolError on $name", ({ text }) => {
    expect(() => parseReviewResponse(text, options())).toThrow(ToolError);
  });

  it("accepts an empty findings response", () => {
    const parsed = parseReviewResponse(response([]), options());
    expect(parsed.findings).toEqual([]);
    expect(parsed.droppedUncited).toBe(0);
  });

  it("keeps the valid findings when one element is malformed, counting the drop", () => {
    const parsed = parseReviewResponse(
      response([finding, { guidelineId: "no-console", line: 5 }, "not even an object"]),
      options(),
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({ guidelineId: "no-console", line: 2 });
    expect(parsed.droppedMalformed).toBe(2);
  });

  it("recovers the complete findings from a reply truncated mid-array", () => {
    const truncated =
      `{"findings":[${JSON.stringify(finding)},` +
      `${JSON.stringify({ ...finding, line: 7 })},{"guidelineId":"no-con`;
    const parsed = parseReviewResponse(truncated, options());
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.map((found) => found.line)).toEqual([2, 7]);
  });

  it("captures the raw payload and reason of each rejected candidate", () => {
    const parsed = parseReviewResponse(
      response([
        finding, // valid
        { guidelineId: "no-console", line: 5 }, // malformed: no file
        { ...finding, guidelineId: "invented-rule" }, // uncited
      ]),
      options(),
    );
    expect(parsed.rejected.map((entry) => entry.reason).sort()).toEqual(["malformed", "uncited"]);
    const uncited = parsed.rejected.find((entry) => entry.reason === "uncited");
    expect(uncited?.raw).toContain("invented-rule");
  });
});

describe("rendering and reporting edges", () => {
  const gate = { threshold: "none", failing: 0, failed: false } as const;

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
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      filtered: 0,
      gate,
    });
    expect(text).toContain("[no-console] t");
    expect(text).not.toContain("         \n");
  });

  it("renders observations and proposals in their own labeled sections", async () => {
    const { renderReview } = await import("../src/review/render.js");
    const text = renderReview({
      violations: [],
      observations: [
        {
          kind: "observation",
          severity: "MINOR",
          file: "a.js",
          line: 3,
          title: "magic number",
          body: "extract a constant",
        },
      ],
      proposals: [{ id: "no-magic-numbers", severity: "MINOR", rationale: "seen twice" }],
      droppedUncited: 0,
      adjustedLines: 0,
      filtered: 2,
      gate,
    });
    expect(text).toContain("observations (general pass, never gate):");
    expect(text).toContain("~ MINOR");
    expect(text).toContain("[observation] magic number");
    expect(text).toContain("proposed guidelines:");
    expect(text).toContain("no-magic-numbers (MINOR): seen twice");
    expect(text).toContain("2 finding(s) under the confidence floor");
  });

  it("builds a report without usage when none was measured", async () => {
    const { buildReport } = await import("../src/review/report.js");
    const report = buildReport({
      findings: [],
      filtered: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      gate,
    });
    expect("usage" in report).toBe(false);
    expect(report.filtered).toEqual([]);
  });

  it("carries the malformed-finding count into the report", async () => {
    const { buildReport } = await import("../src/review/report.js");
    const report = buildReport({
      findings: [],
      filtered: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      droppedMalformed: 3,
      gate,
    });
    expect(report.droppedMalformedFindings).toBe(3);
  });

  it("normalizes missing token counts to zero", async () => {
    const { normalizeUsage } = await import("../src/model/anthropic.js");
    expect(normalizeUsage({ inputTokens: undefined, outputTokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      normalizeUsage({
        inputTokens: 3,
        outputTokens: undefined,
        inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1 },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
  });

  it("renders each waived finding with its reason and expiry state", async () => {
    const { renderReview } = await import("../src/review/render.js");
    const text = renderReview({
      violations: [],
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      filtered: 0,
      waived: [
        { guidelineId: "a", file: "x.js", line: 1, reason: "no date" },
        { guidelineId: "b", file: "y.js", line: 2, reason: "future", until: "2099-01-01" },
        {
          guidelineId: "c",
          file: "z.js",
          line: 3,
          reason: "stale",
          until: "2000-01-01",
          expired: true,
        },
      ],
      gate,
    });
    expect(text).toContain("waived (never gate):");
    expect(text).toContain("a @ x.js:1 — no date");
    expect(text).toContain("(expires 2099-01-01)");
    expect(text).toContain("(expired 2000-01-01)");
  });
});

describe("buildReviewPrompt", () => {
  it("carries guidelines in the system prompt and the fenced diff in the user prompt", () => {
    const request = buildReviewPrompt([guideline], "diff --git a/x b/x\n+console.log(1)\n");
    expect(request.system).toContain("no-console");
    expect(request.system).toContain("MAJOR");
    expect(request.system).toContain("Use the logger instead.");
    expect(request.system).toContain("confidence");
    expect(request.system).not.toContain("proposedGuideline");
    expect(request.user).toContain("<diff>");
    expect(request.user).toContain("console.log(1)");
    expect(request.user).toContain("untrusted");
  });

  it("explains the general pass only when it is enabled", () => {
    const request = buildReviewPrompt([guideline], "diff", { generalPass: true });
    expect(request.system).toContain("proposedGuideline");
    expect(request.system).toContain("no listed guideline covers");
  });

  it("tells the model that a redaction placeholder is not a defect", () => {
    const request = buildReviewPrompt([guideline], "diff");
    expect(request.system).toContain("[redacted:");
    expect(request.system).toContain("valid opaque value");
  });

  it("tells the model to ground findings in the guideline's own words", () => {
    const request = buildReviewPrompt([guideline], "diff");
    expect(request.system).toContain("do not extend a rule by analogy");
  });
});
