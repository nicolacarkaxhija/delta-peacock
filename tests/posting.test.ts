import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { Finding } from "../src/domain/finding.js";
import { isPosted } from "../src/review/posting.js";
import { buildReviewPrompt } from "../src/review/prompt.js";

const VIOLATION: Finding = {
  kind: "violation",
  guidelineId: "values-in-settings",
  severity: "MAJOR",
  file: "src/pricing.js",
  line: 8,
  title: "Amount compared inline",
  body: "Read it from a setting.",
  quote: "  return basket.total >= 50;",
  guidelineQuote: "A business value is read from a setting.",
  confidence: 0.2,
};

/** A violation whose reply carried no confidence. */
const BARE: Finding = { ...VIOLATION };
delete BARE.confidence;

const OBSERVATION: Finding = {
  kind: "observation",
  severity: "MINOR",
  file: "src/pricing.js",
  line: 3,
  title: "Unclear name",
  body: "Name the function after what it returns.",
  confidence: 0.3,
};

const review = (posting?: string) =>
  ConfigSchema.parse({ review: posting === undefined ? {} : { posting } }).review;

describe("isPosted", () => {
  it("posts a placed violation on its evidence by default, whatever confidence the model gave it", () => {
    expect(review().posting).toBe("evidence");
    expect(isPosted(VIOLATION, review())).toBe(true);
    expect(isPosted({ ...VIOLATION, confidence: 0.9 }, review())).toBe(true);
    expect(isPosted(BARE, review())).toBe(true);
  });

  it("holds a violation that sits on no line, whatever its confidence", () => {
    expect(isPosted({ ...VIOLATION, unplaced: true, confidence: 1 }, review())).toBe(false);
  });

  it("holds an observation under the confidence floor, since it cites no evidence", () => {
    expect(isPosted(OBSERVATION, review())).toBe(false);
    expect(isPosted({ ...OBSERVATION, confidence: 0.5 }, review())).toBe(true);
  });

  it("gates every finding on the confidence floor under posting: confidence", () => {
    expect(isPosted(VIOLATION, review("confidence"))).toBe(false);
    expect(isPosted({ ...VIOLATION, confidence: 0.5 }, review("confidence"))).toBe(true);
    expect(isPosted(BARE, review("confidence"))).toBe(true);
  });
});

describe("the review prompt on confidence", () => {
  it("asks the model to leave out what it is unsure of instead of promising a filter", () => {
    const { system } = buildReviewPrompt([], "");
    expect(system).toContain(
      'Report a finding only when its quoted line breaks its quoted sentence; leave out a finding you are unsure of. Set "confidence" honestly.',
    );
    expect(system).not.toContain("filtered, not punished");
  });
});
