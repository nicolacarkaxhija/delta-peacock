import { describe, expect, it } from "vitest";
import type { Guideline, GuidelineCheck } from "../src/domain/guideline.js";
import {
  findCandidates,
  testIdAttributeOf,
  type Candidate,
  type CheckContext,
} from "../src/review/checks/detect.js";
import type { DeclaredTags } from "../src/review/declared.js";

function guideline(id: string, paths: string[]): Guideline {
  return {
    id,
    severity: "MINOR",
    title: id,
    body: "",
    sourcePath: `guidelines/${id}.md`,
    languages: [],
    paths,
    tags: [],
  };
}

const BOUND: Record<GuidelineCheck, Guideline> = {
  selectors: guideline("prefer-test-ids", ["pages/**", "components/**"]),
  comments: guideline("natural-comments", ["pages/**", "tests/**", "components/**"]),
  assertions: guideline("web-first-assertions", ["tests/**"]),
  tags: guideline("axis-tags", ["tests/**"]),
};

const TAGS: DeclaredTags = {
  source: "test-runner.config.ts",
  features: ["@cart", "@pdp", "@homepage"],
  axis: ["@site:EU", "@not-site:US"],
};

const BASE = [
  "export class BasePage {",
  "  currentPath(): string {",
  "    return new URL(this.page.url()).pathname;",
  "  }",
  "  async title(): Promise<string> {",
  "    return this.page.title();",
  "  }",
  "}",
].join("\n");

const CART = [
  "export class CartPage extends BasePage {",
  "  lineItems(): Locator {",
  "    return this.page.getByTestId('cart_product_item');",
  "  }",
  "  async state(): Promise<'has-items' | 'empty'> {",
  "    await items.or(empty).waitFor({ state: 'visible' });",
  "    return (await items.isVisible()) ? 'has-items' : 'empty';",
  "  }",
  "  async shippingAmount(): Promise<number> {",
  "    return 3;",
  "  }",
  "}",
].join("\n");

interface Setup {
  files: Record<string, string>;
  /** Changed lines per file; a file listed as "all" counts every line as added. */
  changed: Record<string, number[] | "all">;
  checks?: GuidelineCheck[];
  declared?: DeclaredTags;
}

function run(setup: Setup): Candidate[] {
  const files: Record<string, string> = {
    "pages/base.ts": BASE,
    "pages/cart.ts": CART,
    ...setup.files,
  };
  const changed = new Map<string, Set<number>>();
  for (const [file, lines] of Object.entries(setup.changed)) {
    const count = (files[file] ?? "").split("\n").length;
    changed.set(
      file,
      new Set(lines === "all" ? Array.from({ length: count }, (_, index) => index + 1) : lines),
    );
  }
  const context: CheckContext = {
    changed,
    read: (file) => files[file],
    files: () => [...Object.keys(files), "README.md"],
    ...(setup.declared !== undefined ? { declared: setup.declared } : {}),
    testIdAttribute: "data-tau",
  };
  const checks = setup.checks ?? ["selectors", "comments", "assertions", "tags"];
  return findCandidates(
    checks.map((check) => ({ guideline: BOUND[check], check })),
    context,
  );
}

const brief = (candidates: Candidate[]): string[] =>
  candidates.map(
    (one) => `${one.file}:${String(one.line)} ${one.shape}${one.judge ? " judged" : ""}`,
  );

describe("the selector check", () => {
  const FOOTER = [
    "import type { Locator } from '@playwright/test';",
    "",
    "/** The regions a site may ship in its footer; which of them it ships varies. */",
    "const KEY_REGION_IDS = ['footer_newsletters', 'footer_navigation'];",
    "",
    "export class Footer extends Component {",
    "  shell(): Locator {",
    "    return this.page.locator(this.hookSelector({ suffix: 'unique', value: 'footer' })).first();",
    "  }",
    "",
    "  /** A presence check over the regions, not a fixed layout. */",
    "  keyRegions(): Locator {",
    "    const regions = KEY_REGION_IDS.map((id) => this.hookSelector({ value: id })).join(', ');",
    "    return this.shell().locator(regions).filter({ visible: true });",
    "  }",
    "",
    "  listed(): Locator {",
    "    const inline = ['a', 'b'].map((id) => this.hookSelector({ value: id })).join(', ');",
    "    return this.page.locator(inline);",
    "  }",
    "}",
  ].join("\n");

  it("flags test ids joined into a CSS list, not the derived hook getByTestId cannot read", () => {
    const found = run({
      files: { "components/footer.ts": FOOTER },
      changed: { "components/footer.ts": "all" },
    });
    expect(brief(found)).toEqual([
      "components/footer.ts:14 test-id-list",
      "components/footer.ts:19 test-id-list",
    ]);
    expect(found[0]?.body).toContain("getByTestId(new RegExp(`^(${KEY_REGION_IDS.join('|')})$`))");
    expect(found[1]?.body).toContain("getByTestId(/^(a|b)$/)");
    expect(found[0]?.suggestion).toBeUndefined();
  });

  const PLP = [
    "export class PlpPage extends BasePage {",
    "  /** The product tiles the listing renders. */",
    "  productTiles(): Locator {",
    "    return this.page",
    "      .locator(this.hookSelector({ value: 'product_tile' }))",
    "      .filter({ visible: true });",
    "  }",
    "  grid(): Locator {",
    "    return this.page.locator('[data-tau=\"grid\"]').first();",
    "  }",
    "  tile(): Locator {",
    "    return this.page.locator(TILE_SELECTOR);",
    "  }",
    "}",
    "const TILE_SELECTOR = '[data-testid=\"tile\"]';",
  ].join("\n");

  it("flags a plain test id behind CSS and writes the getByTestId line", () => {
    const found = run({ files: { "pages/plp.ts": PLP }, changed: { "pages/plp.ts": "all" } });
    expect(brief(found)).toEqual([
      "pages/plp.ts:5 test-id",
      "pages/plp.ts:9 test-id",
      "pages/plp.ts:15 test-id",
    ]);
    expect(found[0]?.suggestion).toBe("      .getByTestId('product_tile')");
    expect(found[1]?.suggestion).toBe("    return this.page.getByTestId('grid').first();");
    expect(found[2]?.suggestion).toBeUndefined();
    expect(found[0]?.form).toBe("getByTestId");
  });

  it("flags the use of an unchanged constant, once, where the change uses it", () => {
    const found = run({ files: { "pages/plp.ts": PLP }, changed: { "pages/plp.ts": [12] } });
    expect(brief(found)).toEqual(["pages/plp.ts:12 test-id"]);
    expect(found[0]?.suggestion).toBe("    return this.page.getByTestId('tile');");
  });

  const PDP = [
    "import type { Locator } from '@playwright/test';",
    "",
    "/** The fit guide's own hooks, after the storefront dropped its two test ids. */",
    "const SIZE_GUIDE_TRIGGER = 'button.b-product_fit_guide-link';",
    "const SIZE_GUIDE_PANEL = 'div.b-drawer.m-fit_guide';",
    "/** The control looks disabled through this class alone. */",
    "const ENABLED = ':not(.m-like-disabled)';",
    "",
    "const BARE = '.bare';",
    "",
    "export class PdpPage extends BasePage {",
    "  /** Every image the main stage carousel holds; it keeps every slide in the DOM. */",
    "  productImages(): Locator {",
    "    return this.page.getByTestId('product_gallery_main').locator('img');",
    "  }",
    "  sizeGuidePanel(): Locator {",
    "    return this.page.locator(SIZE_GUIDE_PANEL).first();",
    "  }",
    "  addToCart(): Locator {",
    "    return this.page",
    "      .locator(this.hookSelector({ value: 'add' }) + ENABLED)",
    "      .first();",
    "  }",
    "  bare(): Locator {",
    "    return this.page.locator(BARE);",
    "  }",
    "  loose(): Locator {",
    "    return this.page.locator('.loose');",
    "  }",
    "  unknown(selector: string): Locator {",
    "    return this.page.locator(selector).or(this.page.locator(this.other));",
    "  }",
    "  static readonly OWN = '.own';",
    "  own(): Locator {",
    "    return this.page.locator(this.OWN).locator(PdpPage.OWN);",
    "  }",
    "}",
  ].join("\n");

  it("asks the judge only where a comment exists that names no reason", () => {
    const found = run({ files: { "pages/pdp.ts": PDP }, changed: { "pages/pdp.ts": "all" } });
    expect(brief(found)).toEqual([
      "pages/pdp.ts:9 css",
      "pages/pdp.ts:14 css judged",
      "pages/pdp.ts:28 css",
      "pages/pdp.ts:33 css",
    ]);
    const judged = found[1];
    expect(judged?.judge?.comments).toEqual([
      {
        line: 12,
        text: "Every image the main stage carousel holds; it keeps every slide in the DOM.",
      },
    ]);
    expect(judged?.judge?.fact).toBe("`'img'` is a CSS selector.");
  });

  it("keeps quiet on lines the change does not touch", () => {
    expect(run({ files: { "pages/pdp.ts": PDP }, changed: { "pages/pdp.ts": [3] } })).toEqual([]);
  });
});

describe("the comment check", () => {
  const COMMENTS = [
    "/** What every page class extends: navigation by page key, consent on the first navigation, the",
    " * configured test id attribute. */",
    "export class Page {",
    "  // The size guide panel has no test id,",
    "  // and its class is the same in every language.",
    "  panel(): void {}",
    "  // The drawer opens late - so it waits.",
    "  late(): void {}",
    "  // A remember-me control, `a - b` in code, and a colon: fine.",
    "  fine(): void {}",
    "  // Fixed this after a long debugging session.",
    "  story(): void {}",
    "  /** A doc with an em dash \u2014 here. */",
    "  em(): void {}",
    "  // eslint-disable-next-line no-console",
    "  // Logs once.",
    "  logs(): void {}",
    "}",
  ].join("\n");

  it("flags multi-line comments, dashes and narration on changed lines only", () => {
    const found = run({
      files: { "pages/page.ts": COMMENTS },
      changed: { "pages/page.ts": [2, 4, 5, 7, 9, 11, 13, 15, 16] },
      checks: ["comments"],
    });
    expect(brief(found)).toEqual([
      "pages/page.ts:2 multi-line",
      "pages/page.ts:4 multi-line",
      "pages/page.ts:7 dash",
      "pages/page.ts:11 narration judged",
      "pages/page.ts:13 dash",
    ]);
    expect(found[1]?.body).toContain(
      "`` // The size guide panel has no test id, and its class is the same in every language. ``",
    );
    expect(found[0]?.body).toContain("`` /** What every page class extends:");
    expect(found[2]?.suggestion).toBe("  // The drawer opens late, so it waits.");
    expect(found[4]?.suggestion).toBe("  /** A doc with an em dash, here. */");
  });
});

describe("the assertion check", () => {
  const SPEC = [
    "import { expect, test } from '../../support/fixtures.js';",
    "",
    "test('a', async ({ accountPage, cart, home, page }) => {",
    "  expect(",
    "    accountPage.currentPath(),",
    "    'lands on login',",
    "  ).toContain('/login');",
    "  expect(['has-items', 'empty'], 'either').toContain(await cart.state());",
    "  expect(await home.hero().isVisible(), 'shows').toBe(true);",
    "  expect(await home.hero().isVisible()).toBeFalsy();",
    "  expect(await home.slides().count()).toBe(3);",
    "  expect(await home.hero().textContent()).toBe('Hi');",
    "  expect(await home.hero().textContent()).toContain('Hi');",
    "  expect(await home.hero().getAttribute('id')).toBe('x');",
    "  expect(await home.hero().isVisible()).not.toBe(false);",
    "  expect(page.url()).toContain('/cart');",
    "  expect(await page.title()).toBe('Cart');",
    "  await expect(home.hero(), 'web first').toBeVisible();",
    "  await expect(cart.lineItems()).toHaveCount(1);",
    "  await expect.poll(() => accountPage.currentPath()).toContain('/x');",
    "  expect(await cart.shippingAmount()).toBe(3);",
    "  expect(await cart.lineItems()).toBeTruthy();",
    "  expect(someValue).toBe(1);",
    "  expect.soft(await home.hero().inputValue()).toBe('v');",
    "  expect(await response.json()).toEqual({});",
    "  expect(1).toBe(await nothing);",
    "  expect(x)",
    "});",
  ].join("\n");

  it("flags snapshot reads inside expect and names the web-first matcher", () => {
    const found = run({
      files: { "tests/smoke/a.spec.ts": SPEC },
      changed: { "tests/smoke/a.spec.ts": "all" },
      checks: ["assertions"],
    });
    expect(brief(found)).toEqual([
      "tests/smoke/a.spec.ts:5 snapshot",
      "tests/smoke/a.spec.ts:8 snapshot",
      "tests/smoke/a.spec.ts:9 snapshot",
      "tests/smoke/a.spec.ts:10 snapshot",
      "tests/smoke/a.spec.ts:11 snapshot",
      "tests/smoke/a.spec.ts:12 snapshot",
      "tests/smoke/a.spec.ts:13 snapshot",
      "tests/smoke/a.spec.ts:14 snapshot",
      "tests/smoke/a.spec.ts:15 snapshot",
      "tests/smoke/a.spec.ts:16 snapshot",
      "tests/smoke/a.spec.ts:17 snapshot",
      "tests/smoke/a.spec.ts:24 snapshot",
    ]);
    const byLine = new Map(found.map((one) => [one.line, one]));
    expect(byLine.get(5)?.form).toBe("toHaveURL");
    expect(byLine.get(5)?.body).toContain("`currentPath()` reads the URL once");
    expect(byLine.get(8)?.form).toBe("toBeVisible");
    expect(byLine.get(8)?.body).toContain("first.or(second)");
    expect(byLine.get(9)?.suggestion).toBe("  await expect(home.hero(), 'shows').toBeVisible();");
    expect(byLine.get(10)?.suggestion).toBe("  await expect(home.hero()).toBeHidden();");
    expect(byLine.get(11)?.suggestion).toBe("  await expect(home.slides()).toHaveCount(3);");
    expect(byLine.get(12)?.suggestion).toBe("  await expect(home.hero()).toHaveText('Hi');");
    expect(byLine.get(13)?.suggestion).toBe("  await expect(home.hero()).toContainText('Hi');");
    expect(byLine.get(14)?.suggestion).toBeUndefined();
    expect(byLine.get(15)?.suggestion).toBeUndefined();
    expect(byLine.get(16)?.form).toBe("toHaveURL");
    expect(byLine.get(17)?.form).toBe("toHaveTitle");
    expect(byLine.get(24)?.form).toBe("toHaveValue");
  });

  it("anchors on the first changed line when the read itself is unchanged", () => {
    const found = run({
      files: { "tests/smoke/a.spec.ts": SPEC },
      changed: { "tests/smoke/a.spec.ts": [7] },
      checks: ["assertions"],
    });
    expect(brief(found)).toEqual(["tests/smoke/a.spec.ts:7 snapshot"]);
  });
});

describe("the tag check", () => {
  const SPEC = [
    "test('the cart shows @cart', async () => {});",
    "test(",
    "  'the homepage renders',",
    "  { tag: ['@not-site:US', '@smoke'] },",
    "  async () => {},",
    ");",
    "test('the pdp', { tag: ['@quickwin'] }, async () => {});",
    "test('declared', { tag: ['@pdp', '@site:EU'] }, async () => {});",
    "test.describe('split', {",
    "  tag: [",
    "    '@cart',",
    "    '@legacy',",
    "  ],",
    "}, () => {});",
    "test('no option', async () => {});",
    "test(`template @inline`, { annotation: [] }, async () => {});",
  ].join("\n");

  it("flags undeclared tags and tags in titles, and suggests the list without the tag", () => {
    const found = run({
      files: { "tests/smoke/b.spec.ts": SPEC },
      changed: { "tests/smoke/b.spec.ts": "all" },
      checks: ["tags"],
      declared: TAGS,
    });
    expect(brief(found)).toEqual([
      "tests/smoke/b.spec.ts:1 title-tag",
      "tests/smoke/b.spec.ts:4 undeclared-tag",
      "tests/smoke/b.spec.ts:7 undeclared-tag",
      "tests/smoke/b.spec.ts:12 undeclared-tag",
      "tests/smoke/b.spec.ts:16 title-tag",
    ]);
    expect(found[1]?.suggestion).toBe("  { tag: ['@not-site:US'] },");
    expect(found[2]?.suggestion).toBeUndefined();
    expect(found[3]?.suggestion).toBeUndefined();
    expect(found[1]?.body).toContain(
      "`@smoke` is neither an axis tag nor a feature tag test-runner.config.ts declares",
    );
  });

  it("checks only titles when the repository declares no tags", () => {
    const found = run({
      files: { "tests/smoke/b.spec.ts": SPEC },
      changed: { "tests/smoke/b.spec.ts": "all" },
      checks: ["tags"],
    });
    expect(brief(found)).toEqual([
      "tests/smoke/b.spec.ts:1 title-tag",
      "tests/smoke/b.spec.ts:16 title-tag",
    ]);
  });
});

describe("edges of each check", () => {
  it("reads shorthand and mixed helpers, and survives code cut off mid call", () => {
    const page = [
      "export class P {",
      "  a(value: string): Locator {",
      "    return this.page.locator(this.hookSelector({ value }));",
      "  }",
      "  b(): Locator {",
      "    return this.page.locator(this.hookSelector({ suffix: 'u', value: 'a' }) + this.hookSelector({ value: 'b' }));",
      "  }",
      "  c(): Locator {",
      "    return this.page.locator(this.hookSelector({ other: 1 }));",
      "  }",
      "  d(): Locator {",
      "    return this.page.locator(",
    ].join("\n");
    const found = run({ files: { "pages/p.ts": page }, changed: { "pages/p.ts": "all" } });
    expect(brief(found)).toEqual(["pages/p.ts:3 test-id"]);
    expect(found[0]?.suggestion).toBe("    return this.page.getByTestId(value);");
    const spec = "test('cut', async () => {\n  expect(await x.isVisible()).toBe(";
    expect(
      brief(
        run({
          files: { "tests/cut.spec.ts": spec },
          changed: { "tests/cut.spec.ts": "all" },
          declared: TAGS,
        }),
      ),
    ).toEqual(["tests/cut.spec.ts:2 snapshot"]);
    const open = "expect(await y.count()";
    expect(
      run({ files: { "tests/o.spec.ts": open }, changed: { "tests/o.spec.ts": "all" } }),
    ).toEqual([]);
    const tail = "expect(await x.isVisible()).toBe(true";
    expect(
      brief(run({ files: { "tests/t.spec.ts": tail }, changed: { "tests/t.spec.ts": "all" } })),
    ).toEqual(["tests/t.spec.ts:1 snapshot"]);
  });

  it("folds a plain block comment and leaves a trailing dash without a suggestion", () => {
    const text = ["/* a plain", "   block */", "// ends with -"].join("\n");
    const found = run({
      files: { "pages/c.ts": text },
      changed: { "pages/c.ts": "all" },
      checks: ["comments"],
    });
    expect(brief(found)).toEqual(["pages/c.ts:1 multi-line", "pages/c.ts:3 dash"]);
    expect(found[0]?.body).toContain("`` /* a plain block */ ``");
    expect(found[1]?.suggestion).toBeUndefined();
  });

  it("skips reads that are not snapshots of the page", () => {
    const spec = [
      "expect(home.hero().isVisible()).toBe(true);",
      "expect(accountPage.asyncPath()).toContain('/x');",
      "expect(await home.slides().count()).toEqual(2);",
      "expect(await home.hero().isVisible()).toBe(false);",
    ].join("\n");
    const base = `${BASE}\nexport class More {\n  async asyncPath(): Promise<string> {\n    return this.page.url();\n  }\n}`;
    const found = run({
      files: { "tests/r.spec.ts": spec, "pages/base.ts": base },
      changed: { "tests/r.spec.ts": "all" },
      checks: ["assertions"],
    });
    expect(brief(found)).toEqual(["tests/r.spec.ts:3 snapshot", "tests/r.spec.ts:4 snapshot"]);
    expect(found[0]?.suggestion).toBe("await expect(home.slides()).toHaveCount(2);");
    expect(found[1]?.suggestion).toBe("await expect(home.hero()).toBeHidden();");
  });

  it("reads single argument tests, computed titles and a lone tag string", () => {
    const spec = [
      "test('solo @one');",
      "test(title + ' @two', async () => {});",
      "test('lone', { tag: '@lone' }, async () => {});",
      "test('kept', { tag: ['@old'] }, async () => {});",
    ].join("\n");
    const found = run({
      files: { "tests/s.spec.ts": spec },
      changed: { "tests/s.spec.ts": [1, 2, 3] },
      checks: ["tags"],
      declared: TAGS,
    });
    expect(brief(found)).toEqual([
      "tests/s.spec.ts:1 title-tag",
      "tests/s.spec.ts:3 undeclared-tag",
    ]);
    expect(found[1]?.suggestion).toBeUndefined();
  });
});

describe("candidate scope", () => {
  it("skips unreadable, non source and out of scope files and duplicate lines", () => {
    const found = run({
      files: { "docs/a.md": "// - dash", "tests/c.spec.ts": "// a - b\n// c" },
      changed: {
        "docs/a.md": [1],
        "pages/gone.ts": [1],
        "tests/c.spec.ts": [1],
        "tests/none.ts": [],
      },
      checks: ["comments", "comments"],
    });
    expect(brief(found)).toEqual(["tests/c.spec.ts:1 multi-line"]);
  });

  it("reads the test id attribute a config names", () => {
    expect(testIdAttributeOf([undefined, "use: { testIdAttribute: 'data-tau' }"])).toBe("data-tau");
    expect(testIdAttributeOf([undefined])).toBe("data-testid");
  });
});
