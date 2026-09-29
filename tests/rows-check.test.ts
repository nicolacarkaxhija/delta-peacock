import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { findCandidates } from "../src/review/checks/detect.js";
import { impliedCheck } from "../src/review/checks/rules.js";

const ROWS: Guideline = {
  id: "data-rows-not-copies",
  severity: "MAJOR",
  title: "Data rows instead of copied scenarios",
  body: "Duplicated tests diverge once a fix reaches only one copy. Sites, products, payment methods and addresses become data rows of one scenario.",
  sourcePath: "guidelines/data-rows-not-copies.md",
  languages: ["typescript"],
  paths: ["tests/**"],
  tags: [],
};

const LOOP = [
  "const sites = [",
  "  { site: 'EU', tag: '@site:EU' },",
  "  { site: 'US', tag: '@site:US' },",
  "];",
  "",
  "for (const { site, tag } of sites) {",
  "  for (const entry of entries) {",
  "    test(`A guest pays with PayPal from ${entry.name} (${site})`, { tag: [tag] }, async ({ checkout }) => {",
  "      test.slow();",
  "      await checkout.pay(entry.name);",
  "    });",
  "  }",
  "}",
  "",
].join("\n");

const COPIES = [
  "test(",
  "  'The homepage hero carousel renders for the German locale',",
  "  { tag: ['@homepage'] },",
  "  async ({ home }) => {",
  "    await home.open();",
  "    await expect(home.heroCarousel(), 'renders').toBeVisible();",
  "  },",
  ");",
  "",
  "test(",
  "  'The homepage hero carousel renders for the Japanese locale',",
  "  { tag: ['@homepage'] },",
  "  async ({ home }) => {",
  "    await home.open();",
  "    await expect(home.heroCarousel(), 'renders').toBeVisible();",
  "  },",
  ");",
  "",
].join("\n");

const all = (text: string): Set<number> => new Set(text.split("\n").map((_, index) => index + 1));

function candidates(files: Record<string, string>, changedFile: string) {
  return findCandidates([{ guideline: ROWS, check: "rows" }], {
    changed: new Map([[changedFile, all(files[changedFile] ?? "")]]),
    read: (file) => files[file],
    files: () => Object.keys(files),
    testIdAttribute: "data-testid",
  }).map((one) => `${one.file}:${String(one.line)} ${one.body.slice(0, 40)}`);
}

describe("the rows check", () => {
  it("is implied by the guideline's own sentence", () => {
    expect(impliedCheck(ROWS)).toBe("rows");
  });

  it("never calls one test body looped over rows a copy", () => {
    const other = "test('slow', async () => {\n  test.slow();\n});\n";
    expect(
      candidates(
        { "tests/journeys/paypal.spec.ts": LOOP, "tests/other.spec.ts": other },
        "tests/journeys/paypal.spec.ts",
      ),
    ).toEqual([]);
  });

  it("flags a test that repeats an earlier one but for its literals", () => {
    expect(
      candidates({ "tests/smoke/copies.spec.ts": COPIES }, "tests/smoke/copies.spec.ts"),
    ).toEqual(["tests/smoke/copies.spec.ts:10 This test repeats the one at line 1 with"]);
  });

  it("flags a spec file that copies another one's test", () => {
    const card = COPIES.split("\n").slice(0, 9).join("\n");
    const paypal = card.replace("German", "French");
    expect(
      candidates(
        { "tests/checkout-card.spec.ts": card, "tests/checkout-paypal.spec.ts": paypal },
        "tests/checkout-paypal.spec.ts",
      ),
    ).toEqual(["tests/checkout-paypal.spec.ts:1 This test repeats the one at tests/check"]);
  });

  it("keeps tests that differ in more than literals", () => {
    const other = COPIES.replace(
      /heroCarousel\(\), 'renders'\)\.toBeVisible\(\);\n {2}},\n\);\n$/,
      "footer(), 'renders').toBeVisible();\n  },\n);\n",
    );
    expect(candidates({ "tests/smoke/two.spec.ts": other }, "tests/smoke/two.spec.ts")).toEqual([]);
  });
});
