import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import type { DeclaredTags } from "../src/review/declared.js";
import { dropCommentMoves, dropUnfitTags } from "../src/review/placement.js";

const WISHLIST = [
  "import type { Locator } from '@playwright/test';",
  "",
  "/** The empty wishlist message carries no test id; matched by its own component class. */",
  "const EMPTY_STATE_SELECTOR = '.b-wishlist-empty_text';",
  "const PLAIN_SELECTOR = '.plain';",
  "",
  "const LONE_SELECTOR = '.lone';",
  "const TRAILING = '.trailing'; // the widget has no test id",
  "const QUOTED = '// not a comment';",
  "",
  "export class WishlistPage {",
  "  emptyMessage(): Locator {",
  "    return this.page.locator(EMPTY_STATE_SELECTOR).first();",
  "  }",
  "  plain(): Locator {",
  "    return this.page.locator(PLAIN_SELECTOR);",
  "  }",
  "  lone(): Locator {",
  "    return this.page.locator(LONE_SELECTOR);",
  "  }",
  "  trailing(): Locator {",
  "    return this.page.locator(TRAILING);",
  "  }",
  "  quoted(): Locator {",
  "    return this.page.locator(QUOTED);",
  "  }",
  "}",
];

function asking(line: number): Finding {
  const quote = (WISHLIST[line - 1] ?? "").trim();
  return {
    kind: "violation",
    guidelineId: "prefer-test-ids",
    severity: "MINOR",
    file: "pages/wishlist.ts",
    line,
    quote,
    title: "CSS selector without a reason",
    body: "Say why no test id serves.",
    suggestion: `${quote} // the message has no test id`,
  };
}

describe("the comment gate follows a constant to its declaration", () => {
  const linesOf = (): readonly string[] => WISHLIST;

  it("drops a comment asked at the use of a constant whose declaration carries the reason", () => {
    const { kept, dropped } = dropCommentMoves([asking(13)], linesOf);
    expect(kept).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["comment-move"]);
  });

  it("counts a comment heading a group of declarations and one trailing the declaration", () => {
    expect(dropCommentMoves([asking(16), asking(22)], linesOf).kept).toEqual([]);
  });

  it("keeps a finding on a constant declared with no comment, or a comment only inside a string", () => {
    const kept = dropCommentMoves([asking(19), asking(25)], linesOf).kept;
    expect(kept.map((finding) => finding.line)).toEqual([19, 25]);
  });
});

const TAGS: DeclaredTags = {
  source: "test-runner.config.ts",
  features: ["@homepage", "@cart", "@pdp-types"],
  axis: ["@site:EU"],
  descriptions: {
    "@homepage": "the homepage and its hero carousel",
    "@cart": "the cart page, its lines, quantities and totals",
  },
};

const SPEC = [
  "import { expect, test } from '../../support/fixtures.js';",
  "",
  "test('Global footer renders its shell and at least one key region', async ({ home }) => {",
  "  await home.open();",
  "});",
  "test(",
  "  'The cart keeps its lines after a reload',",
  "  async ({ cart }) => {",
  "  },",
  ");",
];

function tagFinding(line: number, suggestion?: string, body = "Add a feature tag."): Finding {
  return {
    kind: "violation",
    guidelineId: "axis-tags",
    severity: "MINOR",
    file: "tests/smoke/x.spec.ts",
    line,
    quote: (SPEC[line - 1] ?? "").trim(),
    title: "Missing feature tag",
    body,
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

describe("the tag fit gate", () => {
  const linesOf = (): readonly string[] => SPEC;

  it("drops a feature tag that no word of the test title ties to", () => {
    const footer = tagFinding(
      3,
      "test('Global footer renders its shell and at least one key region', { tag: ['@homepage'] }, async ({ home }) => {",
    );
    const { kept, dropped } = dropUnfitTags([footer], linesOf, TAGS);
    expect(kept).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(["tag-fit"]);
  });

  it("keeps a tag its description ties to, read from the title on the next lines", () => {
    const cart = tagFinding(6, undefined, "Add the @cart tag.");
    expect(dropUnfitTags([cart], linesOf, TAGS).kept).toEqual([cart]);
  });

  it("keeps a finding that adds no declared tag, and runs without declared tags", () => {
    const none = tagFinding(3, undefined, "Remove @smoke.");
    const partial = tagFinding(3, undefined, "Add @pdp-typesx.");
    expect(dropUnfitTags([none, partial], linesOf, TAGS).kept).toEqual([none, partial]);
    expect(dropUnfitTags([none], () => undefined, undefined).kept).toEqual([none]);
    const bare: Finding = { ...none, body: "Add @cart." };
    delete bare.quote;
    expect(dropUnfitTags([bare], () => undefined, TAGS).dropped).toHaveLength(1);
  });

  it("names an observation's drop without a guideline", () => {
    const observation: Finding = {
      kind: "observation",
      severity: "INFO",
      file: "tests/smoke/x.spec.ts",
      line: 3,
      quote: SPEC[2] ?? "",
      title: "t",
      body: "Tag it @cart.",
    };
    const { dropped } = dropUnfitTags([observation], linesOf, TAGS);
    expect(dropped[0]?.guidelineId).toBeUndefined();
  });
});
