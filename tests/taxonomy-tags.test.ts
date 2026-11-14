import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadBacktestCases } from "../src/backtest/cases.js";
import type { Guideline } from "../src/domain/guideline.js";
import { findCandidates, type CheckContext } from "../src/review/checks/detect.js";
import {
  declaredTags,
  declaredTagsBlock,
  isDeclaredTag,
  type DeclaredTags,
} from "../src/review/declared.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASE = "axis-tags-taxonomy-and-built-sites-compliant";

// sites built in code, a listed effect, a required own dimension and one built in code
const CONFIG = [
  "const siteIds = ['alpha', 'beta'];",
  "export default {",
  "  sites: Object.fromEntries(siteIds.map((id) => [id, {}])),",
  "  environments: { qa: {}, prd: { production: true } },",
  "  tags: { features: { notes: 'the note list' } },",
  "  taxonomy: {",
  "    dimensions: {",
  "      effect: { values: { 'sends-mail': 'Sends a mail' } },",
  "      surface: { kind: 'exclusive', required: true, values: { web: 'The web shop' } },",
  "      speed: { required: false, values: { slow: 'Runs long' } },",
  "      owner: { values: ownerRows },",
  "    },",
  "  },",
  "};",
].join("\n");

const read = (source: string): DeclaredTags => {
  const tags = declaredTags(source, "runner.ts");
  if (tags === undefined) throw new Error("the config declares no tags");
  return tags;
};

describe("taxonomy tags a config declares", () => {
  it("lists every dimension value, the engine's risk scale and a tag per feature", () => {
    const tags = read(CONFIG);
    expect(tags.dimensions).toEqual([
      "@risk:P0",
      "@risk:P1",
      "@risk:P2",
      "@risk:P3",
      "@risk:unclassified",
      "@feature:notes",
      "@feature:unclassified",
      "@effect:sends-mail",
      "@surface:web",
      "@surface:unclassified",
      "@speed:slow",
    ]);
    expect(tags.openDimensions).toEqual(["owner"]);
    expect(tags.openAxes).toEqual(["site"]);
  });

  it("takes the risk name and the risk values the config gives, and ignores listed feature values", () => {
    const source = [
      "export default {",
      "  tags: { features: { cart: 'the cart' } },",
      "  taxonomy: { risk: 'priority', dimensions: {",
      "    priority: { values: { high: 'Blocks', low: 'Advisory' } },",
      "    feature: { values: { other: 'not a feature' } },",
      "  } },",
      "};",
    ].join("\n");
    expect(read(source).dimensions).toEqual([
      "@priority:high",
      "@priority:low",
      "@priority:unclassified",
      "@feature:cart",
      "@feature:unclassified",
    ]);
  });

  it("gives the required dimensions to a config that names no taxonomy", () => {
    const tags = read("export default { tags: { features: { cart: 1 } } };");
    expect(tags.dimensions).toContain("@risk:P3");
    expect(tags.dimensions).toContain("@feature:cart");
    expect(tags.openDimensions).toBeUndefined();
  });

  it("reads a config that declares only a taxonomy, and none that declares nothing", () => {
    expect(read("export default { taxonomy: {} };").dimensions).toContain("@risk:P0");
    expect(declaredTags("export default { reporter: 'list' };", "runner.ts")).toBeUndefined();
  });

  it("opens every dimension when the config builds the dimensions or the taxonomy in code", () => {
    expect(
      read("export default { taxonomy: { dimensions: dimensionRows } };").openDimensions,
    ).toEqual(["*"]);
    expect(read("export default { taxonomy: taxonomyFrom(rows) };").openDimensions).toEqual(["*"]);
  });
});

describe("isDeclaredTag", () => {
  it("accepts listed, axis and taxonomy tags, and any value of an open axis or dimension", () => {
    const tags = read(CONFIG);
    for (const tag of [
      "@notes",
      "@env:qa",
      "@not-env:prd",
      "@site:gamma",
      "@not-site:delta",
      "@effect:sends-mail",
      "@risk:unclassified",
      "@owner:team-a",
    ]) {
      expect(isDeclaredTag(tags, tag), tag).toBe(true);
    }
  });

  it("refuses a bare tag, an unlisted value of a closed dimension and unclassified off a required one", () => {
    const tags = read(CONFIG);
    for (const tag of [
      "@smoke",
      "@effect:posts-order",
      "@speed:unclassified",
      "@risk:P4",
      "@device:mobile",
    ]) {
      expect(isDeclaredTag(tags, tag), tag).toBe(false);
    }
  });

  it("accepts any dimension tag when every dimension is open, never a reserved axis word", () => {
    const tags = read("export default { taxonomy: { dimensions: dimensionRows } };");
    expect(isDeclaredTag(tags, "@effect:anything")).toBe(true);
    expect(isDeclaredTag(tags, "@device:mobile")).toBe(false);
    expect(isDeclaredTag(tags, "@smoke")).toBe(false);
  });

  it("keeps the closed list for tags read before the taxonomy existed", () => {
    expect(isDeclaredTag({ source: "r", features: ["@notes"], axis: [] }, "@notes")).toBe(true);
    expect(isDeclaredTag({ source: "r", features: [], axis: [] }, "@risk:P0")).toBe(false);
  });
});

describe("the declared tags block", () => {
  it("names the taxonomy tags and the dimensions whose values code builds", () => {
    const block = declaredTagsBlock(read(CONFIG));
    expect(block).toContain("Taxonomy tags: @risk:P0, @risk:P1");
    expect(block).toContain("@effect:sends-mail, @surface:web");
    expect(block).toContain(
      "Taxonomy dimensions whose values the config builds in code, so any value counts as declared: @owner:<value>",
    );
  });

  it("names every dimension open when the config builds them all", () => {
    const block = declaredTagsBlock(read("export default { taxonomy: taxonomyFrom(rows) };"));
    expect(block).toContain("so any value counts as declared: @<dimension>:<value>");
  });
});

const GUIDELINE: Guideline = {
  id: "axis-tags",
  severity: "MINOR",
  title: "A test carries only the tags the config declares",
  body: "",
  sourcePath: "guidelines/axis-tags.md",
  languages: [],
  paths: ["tests/**"],
  tags: [],
};

describe("the tag check with a taxonomy", () => {
  it("flags only the tags neither the axes, the taxonomy nor the features declare", () => {
    const spec = [
      "test('a', { tag: ['@site:alpha', '@effect:sends-mail', '@notes'] }, async () => {});",
      "test('b', { tag: ['@risk:P1', '@feature:notes', '@not-env:prd'] }, async () => {});",
      "test('c', { tag: ['@effect:posts-order'] }, async () => {});",
      "test('d', { tag: ['@smoke'] }, async () => {});",
    ].join("\n");
    const context: CheckContext = {
      changed: new Map([["tests/a.spec.ts", new Set([1, 2, 3, 4])]]),
      read: (file) => (file === "tests/a.spec.ts" ? spec : undefined),
      files: () => ["tests/a.spec.ts"],
      declared: read(CONFIG),
      testIdAttribute: "data-testid",
    };
    const found = findCandidates([{ guideline: GUIDELINE, check: "tags" }], context);
    expect(found.map((one) => `${String(one.line)} ${one.shape}`)).toEqual([
      "3 undeclared-tag",
      "4 undeclared-tag",
    ]);
  });
});

describe("the taxonomy tag backtest case", () => {
  it("expects one finding for the undeclared tag and none for the taxonomy and open axis tags", () => {
    const [one] = loadBacktestCases(BACKTEST, [CASE]);
    expect(one?.expected).toEqual([
      expect.objectContaining({ guidelineId: "axis-tags", line: 21, severity: "MINOR" }),
    ]);
    expect(one?.noFinding.map((entry) => entry.line)).toEqual([7, 12, 16]);
  });
});
