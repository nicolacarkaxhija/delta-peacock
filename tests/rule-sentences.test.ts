import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { parseReviewResponse, quotesRuleSentence } from "../src/review/parse.js";

const EXCLUSION =
  "A fallback applied only when the configured value is absent is not a tunable value.";

const GUIDELINE: Guideline = {
  id: "limits-from-config",
  severity: "MAJOR",
  title: "Read limits and amounts from configuration",
  body: [
    "# Read limits and amounts from configuration",
    "",
    "A limit or an amount that operations may tune is read from configuration, never compared as a literal. Each one carries its reason.",
    "",
    EXCLUSION,
    "",
    "Good:",
    "",
    "```js",
    "return basket.total >= settings.get('freeShippingFrom');",
    "```",
    "",
    "Bad:",
    "",
    "```js",
    "return basket.total >= 50;",
    "```",
  ].join("\n"),
  sourcePath: "guidelines/limits-from-config.md",
  languages: [],
  paths: [],
  tags: [],
  exclusions: [EXCLUSION],
};

const RULE =
  "A limit or an amount that operations may tune is read from configuration, never compared as a literal.";

describe("quotesRuleSentence", () => {
  it("accepts a whole sentence of the rule text, the heading, and spacing, a missing full stop or emphasis around it", () => {
    expect(quotesRuleSentence(RULE, GUIDELINE)).toBe(true);
    expect(quotesRuleSentence("Each one carries its reason.", GUIDELINE)).toBe(true);
    expect(quotesRuleSentence("Read limits and amounts from configuration", GUIDELINE)).toBe(true);
    expect(quotesRuleSentence(RULE.replace(", never", ",\n   never").slice(0, -1), GUIDELINE)).toBe(
      true,
    );
    expect(quotesRuleSentence(`*${RULE}*`, GUIDELINE)).toBe(true);
  });

  it("refuses a passage of a sentence, a near quote, an example line, a label, an exclusion and nothing", () => {
    expect(
      quotesRuleSentence("read from configuration, never compared as a literal", GUIDELINE),
    ).toBe(false);
    expect(quotesRuleSentence(RULE.replace("may tune", "can tune"), GUIDELINE)).toBe(false);
    expect(quotesRuleSentence("return basket.total >= 50;", GUIDELINE)).toBe(false);
    expect(quotesRuleSentence("Good:", GUIDELINE)).toBe(false);
    expect(quotesRuleSentence(EXCLUSION, GUIDELINE)).toBe(false);
    expect(quotesRuleSentence(undefined, GUIDELINE)).toBe(false);
  });
});

const LISTED: Guideline = {
  ...GUIDELINE,
  body: [
    "# Read limits and amounts from configuration",
    "",
    'The switch is named "enabled". Read a value from configuration, e.g. a setting, never inline. Name it after its use, i.e. what it limits.',
    "",
    "Reviewers refuse these shapes:",
    "",
    "- a limit compared to decide behaviour",
    "- an amount written into a helper",
    "",
    "1. Name the setting in the guideline.",
    "2. Give its default a reason;",
  ].join("\n"),
  exclusions: [],
};

describe("quotesRuleSentence on punctuation and lists", () => {
  it("accepts trivia around a whole sentence, one row each", () => {
    for (const quote of [
      'The switch is named "enabled."',
      "Reviewers refuse these shapes",
      "Reviewers refuse these shapes;",
      "Give its default a reason.",
      "1. Name the setting in the guideline.",
      "- Name the setting in the guideline.",
      "an amount written into a helper",
      "- an amount written into a helper.",
      "Read a value from configuration, e.g. a setting, never inline.",
      "Name it after its use, i.e. what it limits",
    ]) {
      expect(quotesRuleSentence(quote, LISTED), quote).toBe(true);
    }
  });

  it("keeps each bullet a sentence of its own and splits no sentence at an abbreviation", () => {
    for (const quote of [
      "a limit compared to decide behaviour an amount written into a helper",
      "Read a value from configuration, e.g.",
      "a setting, never inline.",
      "Name it after its use, i.e.",
    ]) {
      expect(quotesRuleSentence(quote, LISTED), quote).toBe(false);
    }
  });
});

describe("parsing with evidence on", () => {
  const options = (evidence: boolean) => ({
    guidelinesById: new Map([[GUIDELINE.id, GUIDELINE]]),
    generalPass: false,
    observationSeverityCap: "MINOR" as const,
    ...(evidence ? { evidence: true as const } : {}),
  });
  const reply = JSON.stringify({
    findings: [
      {
        guidelineId: GUIDELINE.id,
        file: "src/pricing.js",
        line: 8,
        title: "Amount compared as a literal",
        body: "Read it from configuration.",
        guidelineQuote: "read from configuration, never compared as a literal",
      },
    ],
  });

  it("drops a finding that quotes only a passage as misquoted, which the plain check accepts", () => {
    expect(parseReviewResponse(reply, options(false)).findings).toHaveLength(1);
    const strict = parseReviewResponse(reply, options(true));
    expect(strict.findings).toEqual([]);
    expect(strict.droppedMisquoted).toBe(1);
  });
});
