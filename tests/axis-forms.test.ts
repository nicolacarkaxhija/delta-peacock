import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBacktestCases } from "../src/backtest/cases.js";
import { loadConfig } from "../src/config/loader.js";
import { buildPromptOptions, buildReviewPrompt } from "../src/review/prompt.js";
import { declaredTags, declaredTagsBlock, readDeclaredTags } from "../src/review/declared.js";

const BACKTEST = fileURLToPath(new URL("../bench/backtest", import.meta.url));
const CASES = ["axis-tags-from-config-code-compliant", "axis-tags-undeclared-feature-tag"];

// values built in code: a spread, an identifier and a call
const BUILT_IN_CODE = [
  "const environmentRows = { qa: {}, prd: {} };",
  "export default {",
  "  sites: siteRowsFor(['alpha', 'beta']),",
  "  environments: { ...environmentRows },",
  "  devices: deviceRows,",
  "  tags: { features: { notes: 'the note list' } },",
  "};",
].join("\n");

describe("axes whose values the config builds in code", () => {
  it("names each axis it could not read as open", () => {
    const tags = declaredTags(BUILT_IN_CODE, "runner.ts");
    expect(tags?.axis).toEqual([]);
    expect(tags?.openAxes).toEqual(["site", "env", "device", "locale"]);
  });

  it("names no axis as open when the config lists every value", () => {
    const source =
      "export default { sites: { alpha: { locales: { en: 1 } } }, environments: { qa: 1 }, devices: { desktop: 1 } };";
    const tags = declaredTags(source, "runner.ts");
    expect(tags?.openAxes).toBeUndefined();
    expect(tags?.axis).toContain("@not-env:qa");
  });

  it("lists the axis values it read beside the axes it could not", () => {
    const source = "export default { sites: { alpha: 1 }, environments: envRows };";
    const block = declaredTagsBlock(
      declaredTags(source, "runner.ts") ?? { source: "", features: [], axis: [] },
    );
    expect(block).toContain("Axis tags: @site:alpha, @not-site:alpha\n");
    expect(block).toContain("so any value counts as declared: @env:<value>, @not-env:<value>,");
  });

  it("accepts every tag of an open axis and never calls the list complete", () => {
    const tags = declaredTags(BUILT_IN_CODE, "runner.ts");
    const block = declaredTagsBlock(tags ?? { source: "", features: [], axis: [] });
    expect(block).toContain(
      "Axis tags whose values the config builds in code, so any value counts as declared: @site:<value>, @not-site:<value>, @env:<value>, @not-env:<value>, @device:<value>, @not-device:<value>, @locale:<value>, @not-locale:<value>",
    );
    expect(block).not.toContain("Axis tags: none");
    expect(block).toContain("No other tag exists in this repository");
  });

  it("reads nothing when the config path names a folder", () => {
    expect(readDeclaredTags(BACKTEST, "axis-tags-undeclared-feature-tag")).toBeUndefined();
  });

  it("keeps the closed list when every axis was read", () => {
    const block = declaredTagsBlock({ source: "r", features: ["@notes"], axis: ["@env:qa"] });
    expect(block).toContain("Axis tags: @env:qa");
    expect(block).not.toContain("builds in code");
  });
});

describe("a guideline's Good example", () => {
  it("is binding for the tags, names and values it uses", () => {
    const { system } = buildReviewPrompt([], "");
    expect(system).toContain(
      "A tag, name or value that a guideline's Good example uses is an accepted form under that guideline: never report it as undeclared, unknown or wrong, whatever another part of this prompt lists.",
    );
  });
});

describe("the axis tag backtest cases", () => {
  it("load, and are replayed with every axis of the synthetic config open", () => {
    const cases = loadBacktestCases(BACKTEST, CASES);
    expect(cases.map((one) => one.name)).toEqual(CASES);
    for (const one of cases) {
      const config = loadConfig({ root: one.baseDir });
      const options = buildPromptOptions(config, one.baseDir);
      expect(options.declarations).toContain("@not-env:<value>, @device:<value>");
      expect(options.declarations).toContain("- @notes: ");
      expect(options.declarations).not.toContain("- @smoke");
    }
  });

  it("expect no finding for axis tags, and a MINOR finding for a tag the config lacks", () => {
    const [compliant, undeclared] = loadBacktestCases(BACKTEST, CASES);
    expect(compliant?.expected).toEqual([]);
    expect(compliant?.noFinding.map((entry) => entry.guidelineId)).toEqual([
      "axis-tags",
      "axis-tags",
    ]);
    expect(undeclared?.expected).toEqual([
      expect.objectContaining({ guidelineId: "axis-tags", severity: "MINOR" }),
    ]);
    const guideline = readFileSync(
      path.join(String(undeclared?.baseDir), "guidelines", "axis-tags.md"),
      "utf8",
    );
    expect(guideline).toContain("severity: MINOR");
  });
});
