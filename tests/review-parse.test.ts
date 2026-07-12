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
});
