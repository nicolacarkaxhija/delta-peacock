import { describe, expect, it } from "vitest";
import type { Finding, Violation } from "../src/domain/finding.js";
import type { Guideline } from "../src/domain/guideline.js";
import { transcriptOf, withFetched } from "../src/model/generate.js";
import {
  declaredTags,
  declaredTagsBlock,
  keysAt,
  objectKeysByPath,
  readDeclaredTags,
} from "../src/review/declared.js";
import { examplesOf, matchesGoodExample } from "../src/review/examples.js";
import {
  dropCommentMoves,
  dropGoodExamples,
  linesFromDiff,
  placeFindings,
  vetSuggestions,
} from "../src/review/placement.js";
import { makeRepo, write } from "./helpers/git.js";

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    kind: "violation",
    guidelineId: "g",
    severity: "MINOR",
    file: "tests/a.spec.ts",
    line: 1,
    title: "t",
    body: "b",
    ...overrides,
  };
}

function guideline(body: string): Guideline {
  return {
    id: "g",
    severity: "MINOR",
    title: "G",
    body,
    sourcePath: "g.md",
    languages: [],
    paths: [],
    tags: [],
  };
}

describe("placeFindings", () => {
  const lines = ["a();", "}", "b();", "}"];

  it("keeps the named line among several that match the quote", () => {
    const [placed] = placeFindings([violation({ line: 4, quote: "}" })], () => lines);
    expect(placed).toMatchObject({ line: 4 });
    expect(placed?.unplaced).toBeUndefined();
  });

  it("places nothing on a quote that matches several other lines", () => {
    const [placed] = placeFindings([violation({ line: 1, quote: "}" })], () => lines);
    expect(placed?.unplaced).toBe(true);
    expect(placed?.note).toContain("appears more than once");
  });

  it("places nothing when the file cannot be read", () => {
    const [placed] = placeFindings([violation({ quote: "a();" })], () => undefined);
    expect(placed?.note).toContain("could not be read");
  });

  it("treats a blank quote as no quote", () => {
    const [placed] = placeFindings([violation({ quote: "  \n " })], () => lines);
    expect(placed?.note).toContain("did not quote");
  });

  it("reads the quote's first non-empty line", () => {
    const [placed] = placeFindings([violation({ line: 9, quote: "\n  b();\n" })], () => lines);
    expect(placed?.line).toBe(3);
  });

  it("rebuilds a file's lines from what the diff shows", () => {
    expect(
      linesFromDiff(
        new Map([
          [2, "x"],
          [4, "y"],
        ]),
      ),
    ).toEqual(["", "x", "", "y"]);
    expect(linesFromDiff(new Map())).toEqual([]);
  });
});

describe("vetSuggestions", () => {
  function repo(): string {
    const cwd = makeRepo();
    write(
      cwd,
      "package.json",
      JSON.stringify({ name: "suite", devDependencies: { "@scope/kit": "1" } }),
    );
    write(cwd, "support/fixtures.ts", "export {};\n");
    return cwd;
  }
  const tags = { source: "runner.ts", features: ["@cart"], axis: ["@site:EU"] };
  const vet = (finding: Finding, cwd = repo()) => vetSuggestions([finding], { cwd, tags })[0];

  it("keeps declared tags and tags the quoted line already had", () => {
    expect(
      vet(violation({ suggestion: "{ tag: ['@cart', '@site:EU'] }" }))?.suggestion,
    ).toBeDefined();
    expect(
      vet(violation({ quote: "{ tag: ['@legacy'] }", suggestion: "{ tag: ['@legacy', '@cart'] }" }))
        ?.suggestion,
    ).toBeDefined();
  });

  it("drops a suggestion naming an undeclared tag", () => {
    const vetted = vet(violation({ suggestion: "{ tag: ['@smoke'] }" }));
    expect(vetted?.suggestion).toBeUndefined();
    expect(vetted?.note).toContain("`@smoke` is not a tag runner.ts declares");
  });

  it("checks relative imports against the files on disk", () => {
    const ok = vet(violation({ suggestion: "import { test } from '../support/fixtures.js';" }));
    expect(ok?.suggestion).toBeDefined();
    const missing = vet(violation({ suggestion: "import { x } from '../support/nowhere.js';" }));
    expect(missing?.note).toContain("imports `../support/nowhere.js`");
  });

  it("checks package imports against package.json, builtins always pass", () => {
    expect(
      vet(violation({ suggestion: "import { a } from '@scope/kit/sub';" }))?.suggestion,
    ).toBeDefined();
    expect(
      vet(violation({ suggestion: "const fs = require('node:fs');" }))?.suggestion,
    ).toBeDefined();
    expect(vet(violation({ suggestion: "import path from 'path';" }))?.suggestion).toBeDefined();
    expect(vet(violation({ suggestion: "import x from 'left-pad';" }))?.note).toContain("left-pad");
  });

  it("cannot judge packages without a readable package.json", () => {
    const cwd = makeRepo();
    expect(
      vet(violation({ suggestion: "import x from 'left-pad';" }), cwd)?.suggestion,
    ).toBeDefined();
    write(cwd, "package.json", "{ not json");
    expect(
      vet(violation({ suggestion: "import x from 'left-pad';" }), cwd)?.suggestion,
    ).toBeDefined();
    write(cwd, "package.json", "{}");
    expect(
      vet(violation({ suggestion: "import x from 'left-pad';" }), cwd)?.suggestion,
    ).toBeUndefined();
    // an import the quoted line already had is not the suggestion's doing
    expect(
      vet(
        violation({ quote: "import x from 'left-pad';", suggestion: "import y from 'left-pad';" }),
        cwd,
      )?.suggestion,
    ).toBeDefined();
  });

  it("leaves findings without a suggestion, and tags alone without declarations", () => {
    expect(vet(violation())).toEqual(violation());
    const [kept] = vetSuggestions([violation({ suggestion: "{ tag: ['@smoke'] }" })], {
      cwd: repo(),
    });
    expect(kept?.suggestion).toBeDefined();
  });
});

describe("Good examples", () => {
  const body = [
    "Rule.",
    "",
    "**Good example:**",
    "```ts",
    "use(fixture);",
    "shared();",
    "```",
    "## Notes",
    "```ts",
    "ignored();",
    "```",
    "Don't:",
    "```ts",
    "shared();",
    "```",
  ].join("\n");

  it("reads labelled fences only", () => {
    expect(examplesOf(body)).toEqual({ good: ["use(fixture);\nshared();"], bad: ["shared();"] });
  });

  it("matches only code the Good example shows and the Bad one does not", () => {
    expect(matchesGoodExample("use(fixture);", guideline(body))).toBe(true);
    expect(matchesGoodExample("shared();", guideline(body))).toBe(false);
    expect(matchesGoodExample("use(", guideline(body))).toBe(false);
  });

  it("drops only violations quoting a Good example", () => {
    const observation: Finding = { ...violation({ quote: "use(fixture);" }), kind: "observation" };
    const result = dropGoodExamples(
      [violation({ quote: "use(fixture);" }), violation(), observation],
      new Map([["g", guideline(body)]]),
    );
    expect(result.kept).toHaveLength(2);
    expect(result.dropped[0]?.reason).toBe("good-example");
  });
});

describe("a fix that only moves a reason", () => {
  const file = [
    "export class HomePage {",
    "  // No test id on the panel; the class is the same in every language.",
    "  sizeGuidePanel(): Locator {",
    "    return this.page.locator('.size-guide-panel');",
    "  }",
    "  /** The trigger has no test id either. */",
    "  trigger(): Locator {",
    "    return this.page.locator('.trigger');",
    "  }",
    "}",
  ];
  const quote = "    return this.page.locator('.size-guide-panel');";
  const linesOf = (name: string) => (name === "pages/home.ts" ? file : undefined);
  const at = (line: number, overrides: Partial<Violation>) =>
    violation({ file: "pages/home.ts", line, quote, ...overrides });

  it("drops a finding whose suggestion repeats a comment already above the line", () => {
    const inline = at(4, {
      suggestion: `${quote} // No test id on the panel; the class is the same in every language.`,
    });
    const above = at(8, {
      quote: "    return this.page.locator('.trigger');",
      suggestion:
        "    /** The trigger has no test id either. */\n    return this.page.locator('.trigger');",
    });
    const result = dropCommentMoves([inline, above], linesOf);
    expect(result.kept).toEqual([]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual(["comment-move", "comment-move"]);
  });

  it("keeps a finding that changes the code, adds a new reason, or has nothing to compare", () => {
    const newReason = at(4, { suggestion: `${quote} // the storefront renders no test id here` });
    const changed = at(4, { suggestion: "    return this.page.getByTestId('size_guide_panel');" });
    const bare = at(4, { suggestion: `${quote} //` });
    const noSuggestion = at(4, {});
    const elsewhere = at(4, {
      file: "pages/other.ts",
      suggestion: `${quote} // No test id on the panel; the class is the same in every language.`,
    });
    const result = dropCommentMoves([newReason, changed, bare, noSuggestion, elsewhere], linesOf);
    expect(result.kept).toHaveLength(5);
    expect(result.dropped).toEqual([]);
  });
});

describe("declared tags edges", () => {
  it("skips comments, strings, templates and ternaries", () => {
    const source = [
      "/* sites: { XX: 1 } */",
      "const a = `sites: { YY: 1 }`;",
      "export default {",
      "  // devices: { ZZ: 1 },",
      "  devices: { desktop: flag ? 'a' : 'b', \"mobile\": [1, 2], 3: 1 },",
      "  sites: {},",
      "};",
      "call({ tags: { features: { cart: '}' } } })",
    ].join("\n");
    const index = objectKeysByPath(source);
    expect(keysAt(index, "devices")).toEqual(["desktop", "mobile"]);
    expect(keysAt(index, "tags.features")).toEqual(["cart"]);
    expect(declaredTags(source, "c.ts")?.axis).toContain("@device:mobile");
    expect(declaredTags("export default {}", "c.ts")).toBeUndefined();
  });

  it("handles escapes, stray closers, unsafe keys and a closing line comment", () => {
    const source = "} { tags: { features: { 'it\\'s': 1, 'a b': 2, ok: 3 } } } // end";
    expect(keysAt(objectKeysByPath(source), "tags.features")).toEqual(["ok"]);
  });

  it("reads what each feature covers, and lists a feature the config leaves undescribed bare", () => {
    const source = [
      "export default {",
      "  tags: { features: { cart: 'the cart page', 'pdp-types': \"the pinned types\", plp: 3, bad: `x` } },",
      "  other: { features: { cart: 'not this one' } },",
      "};",
    ].join("\n");
    const tags = declaredTags(source, "c.ts");
    expect(tags?.descriptions).toEqual({
      "@cart": "the cart page",
      "@pdp-types": "the pinned types",
    });
    const block = declaredTagsBlock(tags ?? { source: "none", features: [], axis: [] });
    expect(block).toContain(
      "- @cart: the cart page\n- @pdp-types: the pinned types\n- @plp\n- @bad",
    );
    expect(block).toContain(
      "a page the test only opens on the way does not make that page's tag fit",
    );
    expect(
      declaredTags("export default { tags: { features: { cart: 1 } } }", "c.ts")?.descriptions,
    ).toBeUndefined();
  });

  it("survives unterminated input", () => {
    expect(keysAt(objectKeysByPath("x = { sites: { EU: 1, 'US"), "sites")).toEqual(["EU"]);
    expect(objectKeysByPath("/* open").size).toBe(0);
  });

  it("reads nothing when the file is absent or the path is empty", () => {
    const cwd = makeRepo();
    expect(readDeclaredTags(cwd, "")).toBeUndefined();
    expect(readDeclaredTags(cwd, "runner.ts")).toBeUndefined();
    write(cwd, "runner.ts", "export default { tags: { features: { cart: 1 } } };");
    const tags = readDeclaredTags(cwd, "runner.ts");
    expect(tags?.features).toEqual(["@cart"]);
    expect(declaredTagsBlock({ source: "r", features: [], axis: [] })).toContain(
      "Feature tags: none",
    );
  });
});

describe("the answering step's text", () => {
  it("writes every tool result as plain data after the prompt", () => {
    const transcript = transcriptOf([
      {
        toolResults: [
          { toolName: "search", input: { text: "x" }, output: "a.ts:1: x" },
          { toolName: "read", input: {}, output: { type: "json", value: { hits: 2 } } },
          { toolName: "read", input: {}, output: { type: "text", value: "file" } },
          { toolName: "read", input: {}, output: 7 },
        ],
      },
    ]);
    expect(transcript).toBe(
      'search {"text":"x"} returned:\na.ts:1: x\n\nread {} returned:\n{"hits":2}\n\nread {} returned:\nfile\n\nread {} returned:\n7',
    );
    expect(withFetched("review", transcript)).toContain("<fetched>\nsearch");
    expect(withFetched("review", "")).toBe("review");
    expect(withFetched("review", undefined)).toBe("review");
  });
});
