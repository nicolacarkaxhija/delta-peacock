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
    const unlisted: Guideline = { ...GUIDELINE };
    delete unlisted.exclusions;
    expect(quotesRuleSentence(EXCLUSION, unlisted)).toBe(true);
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
    "- a limit compared to decide behavior",
    "- an amount written into a helper",
    "",
    "1. Name the setting in the guideline.",
    "2. Give its default a reason;",
    "",
    "These need a setting:",
    "- a threshold a business user",
    "  could change",
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
      "These need a setting",
      "a threshold a business user could change",
    ]) {
      expect(quotesRuleSentence(quote, LISTED), quote).toBe(true);
    }
  });

  it("keeps each bullet a sentence of its own and splits no sentence at an abbreviation", () => {
    for (const quote of [
      "a limit compared to decide behavior an amount written into a helper",
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

/** A guideline whose body is the given lines. */
const bodied = (...lines: string[]): Guideline => ({
  ...GUIDELINE,
  body: lines.join("\n"),
  exclusions: [],
});

describe("quotesRuleSentence on abbreviations", () => {
  const rule = bodied(
    "Never log secrets, tokens, etc. Always hash passwords.",
    "",
    "Keep logs, traces, etc. 30 days at most.",
    "",
    "Weigh speed vs. cost before caching. Pick one vs. Never both.",
    "",
    "Use a guard, e.g. Optional chaining, before reading.",
    "",
    "Avoid logs, traces, etc. in hot paths.",
  );

  it("ends a sentence at etc. before a capital or a digit, and never at vs. or e.g.", () => {
    for (const [quote, citable] of [
      ["Never log secrets, tokens, etc.", true],
      ["Always hash passwords.", true],
      ["Never log secrets, tokens, etc. Always hash passwords.", false],
      ["Keep logs, traces, etc.", true],
      ["30 days at most.", true],
      ["Weigh speed vs. cost before caching.", true],
      ["Weigh speed vs.", false],
      ["Pick one vs.", false],
      ["Pick one vs. Never both.", true],
      ["Use a guard, e.g. Optional chaining, before reading.", true],
      ["Use a guard, e.g.", false],
      ["Avoid logs, traces, etc. in hot paths.", true],
      ["Avoid logs, traces, etc.", false],
    ] as const) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(citable);
    }
  });
});

describe("quotesRuleSentence on example blocks", () => {
  const rule = bodied(
    "Hash every password before it is stored.",
    "",
    "Good: use hash().",
    "",
    "Bad example:",
    "",
    "Good example: hash it.",
    "",
    "- Bad: eval(x)",
    "",
    "1. Good: x",
    "",
    "* **Good**: use hash()",
    "",
    "> Bad: quoted",
    "",
    "Incorrect:",
    "",
    "Example (bad):",
    "",
    "**Bad:**",
    "",
    "Bad",
    "",
    "Good: x. Always escape output.",
    "",
    "Bad code is refused in review.",
    "",
    "Do not log a token.",
  );

  it("never cites an example block, whatever follows its label, one row each", () => {
    for (const quote of [
      "Good: use hash().",
      "use hash().",
      "Bad example",
      "Good example: hash it.",
      "hash it.",
      "Bad: eval(x)",
      "- Bad: eval(x)",
      "Good: x",
      "1. Good: x",
      "**Good**: use hash()",
      "Bad: quoted",
      "Incorrect",
      "Example (bad)",
      "**Bad:**",
      "Bad",
      "Always escape output.",
      "Good: x. Always escape output.",
    ]) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(false);
    }
  });

  it("still cites prose that starts with a label word and has no colon after it", () => {
    for (const quote of [
      "Hash every password before it is stored.",
      "Bad code is refused in review.",
      "Do not log a token.",
    ]) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(true);
    }
  });
});

describe("quotesRuleSentence on code and quotes", () => {
  const rule = bodied(
    "Hash every password.",
    "",
    "```js",
    "Never cite this line.",
    "```",
    "",
    "~~~",
    "Nor this one.",
    "~~~",
    "",
    "    Nor an indented line.",
    "",
    "> Nor a quoted rule.",
    "> Nor its second line.",
  );

  it("never cites fenced code with backticks or tildes, indented code or a block quote", () => {
    for (const quote of [
      "Never cite this line.",
      "Nor this one.",
      "Nor an indented line.",
      "Nor a quoted rule.",
      "Nor its second line.",
    ]) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(false);
    }
    expect(quotesRuleSentence("Hash every password.", rule)).toBe(true);
  });
});

describe("quotesRuleSentence on paragraphs, items and headings", () => {
  it("joins every soft wrapped line into its paragraph, whatever the next line starts with", () => {
    for (const next of [
      "`logger.info` is used.",
      "Logger is used.",
      "2 loggers are used.",
      '"logger" is used.',
      "(the logger) is used.",
    ]) {
      const rule = bodied("A value is read through the", next);
      const whole = `A value is read through the ${next}`;
      expect(quotesRuleSentence(whole, rule), whole).toBe(true);
      expect(quotesRuleSentence("A value is read through the", rule), next).toBe(false);
      expect(quotesRuleSentence(next, rule), next).toBe(false);
    }
  });

  it("makes two bare lines one unit, so only both together are a valid quote", () => {
    const rule = bodied("use const", "prefer let");
    expect(quotesRuleSentence("use const prefer let", rule)).toBe(true);
    expect(quotesRuleSentence("use const", rule)).toBe(false);
    expect(quotesRuleSentence("prefer let", rule)).toBe(false);
  });

  it("keeps a heading and a wrapped list item one unit each, even with several sentences", () => {
    const rule = bodied(
      "# Use the logger",
      "Write through the module logger.",
      "",
      "- Never print to the console. Use the logger.",
      "  It keeps the format.",
    );
    for (const [quote, citable] of [
      ["Use the logger", true],
      ["Write through the module logger.", true],
      ["Use the logger Write through the module logger.", false],
      ["Never print to the console. Use the logger. It keeps the format.", true],
      ["Never print to the console.", false],
    ] as const) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(citable);
    }
  });
});

describe("quotesRuleSentence on emphasis and code marks", () => {
  const rule = bodied("Call `logger.info` for each step.", "", "Keep a*b as written.");

  it("drops marks at a word boundary and keeps one inside a word", () => {
    expect(quotesRuleSentence("Call logger.info for each step.", rule)).toBe(true);
    expect(quotesRuleSentence("Keep a*b as written.", rule)).toBe(true);
    expect(quotesRuleSentence("Keep ab as written.", rule)).toBe(false);
  });
});

describe("quotesRuleSentence on sentence ends before closing marks", () => {
  it("splits after a closing bracket or quote that follows the end mark", () => {
    for (const [body, first, second] of [
      ["Never log (secrets.) Always hash.", "Never log (secrets.)", "Always hash."],
      ['Say "no." Then stop.', 'Say "no."', "Then stop."],
    ] as const) {
      const rule = bodied(body);
      expect(quotesRuleSentence(first, rule), first).toBe(true);
      expect(quotesRuleSentence(second, rule), second).toBe(true);
      expect(quotesRuleSentence(body, rule), body).toBe(false);
    }
  });
});

describe("quotesRuleSentence on nested list items", () => {
  it("keeps a nested item its own unit at two, three or four spaces and a tab", () => {
    for (const indent of ["  ", "   ", "    ", "\t"]) {
      const rule = bodied("- Hash every password.", `${indent}- Use a slow hash.`);
      expect(quotesRuleSentence("Hash every password.", rule), JSON.stringify(indent)).toBe(true);
      expect(quotesRuleSentence("Use a slow hash.", rule), JSON.stringify(indent)).toBe(true);
      expect(quotesRuleSentence("Hash every password. - Use a slow hash.", rule)).toBe(false);
    }
  });
});

describe("quotesRuleSentence on a label inside a block", () => {
  it("cites only what comes before a sentence that opens with a label and a colon", () => {
    const paragraph = bodied("Read this. Good: use hash(). Then this.");
    expect(quotesRuleSentence("Read this.", paragraph)).toBe(true);
    expect(quotesRuleSentence("Good: use hash().", paragraph)).toBe(false);
    expect(quotesRuleSentence("Then this.", paragraph)).toBe(false);
    const item = bodied("- Hash every password.", "  Good: bcrypt.");
    expect(quotesRuleSentence("Hash every password.", item)).toBe(true);
    expect(quotesRuleSentence("Hash every password. Good: bcrypt.", item)).toBe(false);
    const wrapped = bodied("Hash every password.", "Good: bcrypt.");
    expect(quotesRuleSentence("Hash every password.", wrapped)).toBe(true);
    expect(quotesRuleSentence("Good: bcrypt.", wrapped)).toBe(false);
  });

  it("keeps a later sentence that starts with a label word but has no colon", () => {
    const rule = bodied("Read this. Do not log a token.");
    expect(quotesRuleSentence("Do not log a token.", rule)).toBe(true);
  });
});

describe("quotesRuleSentence on a label block and a label heading", () => {
  it("refuses the block after a block that is only a label, with or without a colon", () => {
    for (const label of ["Good:", "Bad", "**Example:**"]) {
      const rule = bodied(
        "Hash every password.",
        "",
        label,
        "",
        "Store the hash only.",
        "",
        "Rotate keys yearly.",
      );
      expect(quotesRuleSentence("Hash every password.", rule), label).toBe(true);
      expect(quotesRuleSentence("Store the hash only.", rule), label).toBe(false);
      expect(quotesRuleSentence("Rotate keys yearly.", rule), label).toBe(true);
    }
  });

  it("refuses a whole section under a heading that is only a label, up to a heading of the same or a higher level", () => {
    const rule = bodied(
      "# Passwords",
      "Hash every password.",
      "",
      "## Bad",
      "Store it as typed.",
      "",
      "### Detail",
      "Log it on failure.",
      "",
      "## Keys",
      "Rotate keys yearly.",
    );
    for (const [quote, citable] of [
      ["Hash every password.", true],
      ["Bad", false],
      ["Store it as typed.", false],
      ["Detail", false],
      ["Log it on failure.", false],
      ["Keys", true],
      ["Rotate keys yearly.", true],
    ] as const) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(citable);
    }
  });
});

describe("quotesRuleSentence on comments and breaks", () => {
  it("never cites an HTML comment or a thematic break", () => {
    const rule = bodied(
      "Hash every password.",
      "",
      "<!-- Never cite this. -->",
      "",
      "<!--",
      "Nor this.",
      "-->",
      "",
      "---",
      "",
      "* * *",
      "",
      "Store the hash only.",
    );
    for (const [quote, citable] of [
      ["Hash every password.", true],
      ["Never cite this.", false],
      ["<!-- Never cite this. -->", false],
      ["Nor this.", false],
      ["---", false],
      ["* * *", false],
      ["Store the hash only.", true],
    ] as const) {
      expect(quotesRuleSentence(quote, rule), quote).toBe(citable);
    }
  });
});

describe("quotesRuleSentence on indented lines that start with a marker", () => {
  it("reads them as code after a blank line when no list is open", () => {
    for (const [lines, refused] of [
      [
        ["Never do this:", "", "    - name: eval", "    - run: x", "    1. step"],
        ["name: eval", "run: x", "step"],
      ],
      [
        ["Hash every password.", "", "    * @param x", "    * eval(y)"],
        ["@param x", "eval(y)"],
      ],
      [["Hash every password.", "", "\t- run: x"], ["run: x"]],
    ] as const) {
      const rule = bodied(...lines);
      for (const quote of refused) expect(quotesRuleSentence(quote, rule), quote).toBe(false);
    }
  });

  it("reads one as a nested item after a blank line while a list is open, and without a blank line under an item", () => {
    const afterBlank = bodied("- Hash every password.", "", "    - Use a slow hash.");
    expect(quotesRuleSentence("Use a slow hash.", afterBlank)).toBe(true);
    const tabbed = bodied("- Hash every password.", "", "\t- Use a slow hash.");
    expect(quotesRuleSentence("Use a slow hash.", tabbed)).toBe(true);
    const direct = bodied("- Hash every password.", "    - Use a slow hash.");
    expect(quotesRuleSentence("Use a slow hash.", direct)).toBe(true);
  });

  it("joins an indented marker line to the paragraph it follows without a blank line", () => {
    const rule = bodied("Never do this:", "    - name: eval");
    expect(quotesRuleSentence("name: eval", rule)).toBe(false);
    expect(quotesRuleSentence("Never do this: - name: eval", rule)).toBe(true);
  });

  it("closes the list at a paragraph, so a later indented marker line is code", () => {
    const rule = bodied("- Hash every password.", "", "Store the hash only.", "", "    - run: x");
    expect(quotesRuleSentence("Store the hash only.", rule)).toBe(true);
    expect(quotesRuleSentence("run: x", rule)).toBe(false);
  });
});
