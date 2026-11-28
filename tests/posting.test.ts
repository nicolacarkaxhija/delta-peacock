import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { Finding } from "../src/domain/finding.js";
import { holdReason, isPosted } from "../src/domain/hold.js";
import { evidenceFlag, skippedCheckContext } from "../src/review/posting.js";
import { buildReviewPrompt } from "../src/review/prompt.js";

const VIOLATION: Finding = {
  kind: "violation",
  guidelineId: "limits-from-config",
  severity: "MAJOR",
  file: "src/pricing.js",
  line: 8,
  title: "Amount compared as a literal",
  body: "Read it from configuration.",
  quote: "  return basket.total >= 50;",
  guidelineQuote: "A limit or an amount is read from configuration.",
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

const LISTS = { exclusions: ["A fallback is not a tunable value."] };

const review = (posting?: string) =>
  ConfigSchema.parse({ review: posting === undefined ? {} : { posting } }).review;

describe("isPosted", () => {
  it("gates every finding on the confidence floor by default", () => {
    expect(review().posting).toBe("confidence");
    expect(isPosted(VIOLATION, review())).toBe(false);
    expect(isPosted({ ...VIOLATION, confidence: 0.5 }, review())).toBe(true);
    expect(isPosted(BARE, review())).toBe(true);
  });

  it("posts a placed violation on its evidence under posting: evidence, whatever its confidence", () => {
    expect(isPosted(VIOLATION, review("evidence"))).toBe(true);
    expect(isPosted({ ...VIOLATION, confidence: 0.9 }, review("evidence"))).toBe(true);
  });

  it.each([["confidence"], ["evidence"]])(
    "holds a violation its quote could not place as unplaced under posting: %s, whatever its confidence",
    (posting) => {
      expect(holdReason({ ...VIOLATION, unplaced: true, confidence: 1 }, review(posting))).toBe(
        "unplaced",
      );
      expect(holdReason({ ...VIOLATION, unplaced: true }, review(posting))).toBe("unplaced");
      expect(holdReason({ ...VIOLATION, unplaced: true, confidence: 0.1 }, review(posting))).toBe(
        "unplaced",
      );
    },
  );

  it("keeps the floor for an unplaced observation, since the hold on no line is for violations", () => {
    expect(holdReason({ ...OBSERVATION, unplaced: true }, review())).toBe("floor");
    expect(isPosted({ ...OBSERVATION, unplaced: true, confidence: 0.9 }, review())).toBe(true);
  });

  it("holds a violation whose guideline lists exclusions where no verdict was asked, under posting: evidence", () => {
    const audit = { verdictsAsked: false, guideline: LISTS };
    expect(isPosted(VIOLATION, review("evidence"), audit)).toBe(false);
    expect(isPosted(VIOLATION, review("evidence"), { ...audit, guideline: {} })).toBe(true);
    expect(isPosted(VIOLATION, review("evidence"), { guideline: LISTS })).toBe(true);
    expect(isPosted({ ...VIOLATION, confidence: 0.6 }, review(), audit)).toBe(true);
  });

  it("keeps the floor for an observation under posting: evidence, since it cites no evidence", () => {
    expect(isPosted(OBSERVATION, review("evidence"))).toBe(false);
    expect(isPosted({ ...OBSERVATION, confidence: 0.5 }, review("evidence"))).toBe(true);
  });
});

describe("evidenceFlag", () => {
  it("is set only under posting: evidence", () => {
    expect(evidenceFlag(review())).toEqual({});
    expect(evidenceFlag(review("evidence"))).toEqual({ evidence: true });
  });
});

describe("the review prompt on confidence", () => {
  const LEAVE_OUT =
    'Report a finding only when its quoted line breaks its quoted sentence; leave out a finding you are unsure of. Set "confidence" honestly.';
  const FILTERED =
    'Set "confidence" honestly; uncertain findings with low confidence are filtered, not punished.';

  it("promises the floor by default and asks to leave out what is unsure under posting: evidence", () => {
    expect(buildReviewPrompt([], "").system).toContain(FILTERED);
    const evidence = buildReviewPrompt([], "", { generalPass: false, evidence: true }).system;
    expect(evidence).toContain(LEAVE_OUT);
    expect(evidence).not.toContain(FILTERED);
  });
});

describe("skippedCheckContext", () => {
  const guideline = { exclusions: ["A fallback is not a tunable value."] };
  const byId = new Map([["limits-from-config", guideline]]);

  it("marks a model finding whose exclusion check was skipped, never a check finding at the same place", () => {
    const fromCheck: Finding = { ...VIOLATION, confidence: 1 };
    const contextOf = skippedCheckContext([VIOLATION], [fromCheck], byId);
    expect(contextOf(VIOLATION)).toEqual({});
    const skippedOnly = skippedCheckContext([VIOLATION], [], byId);
    expect(skippedOnly(VIOLATION)).toEqual({ verdictsAsked: false, guideline });
    expect(skippedOnly({ ...VIOLATION, line: 9 })).toEqual({});
    expect(skippedOnly(OBSERVATION)).toEqual({});
  });
});
