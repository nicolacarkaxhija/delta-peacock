import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { loadGuidelinesFromFiles } from "../src/guidelines/loader.js";
import { resolvePack } from "../src/guidelines/packs.js";
import { CHECK_SENTENCES, impliedCheck } from "../src/review/checks/rules.js";
import { quotesGuideline } from "../src/review/parse.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The frontmatter tag of a rule only the model can judge. */
const JUDGED = "judged";

function shippedGuidelines(): Guideline[] {
  return readdirSync(new URL("../packs", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const loaded = loadGuidelinesFromFiles(resolvePack(repoRoot, `packs/${entry.name}`).files);
      expect(loaded.problems).toEqual([]);
      return loaded.guidelines;
    });
}

describe("the shipped packs and the static checks", () => {
  const guidelines = shippedGuidelines();

  it("give every check sentence a pack rule that says it word for word", () => {
    const sentences = new Set(
      Object.values(CHECK_SENTENCES).flatMap((shapes): string[] => Object.values(shapes)),
    );
    const missing = [...sentences].filter(
      (sentence) => !guidelines.some((guideline) => quotesGuideline(sentence, guideline)),
    );
    expect(missing).toEqual([]);
  });

  it("give every check a pack rule it owns", () => {
    const owned = new Set<string | undefined>(
      guidelines.map((guideline) => impliedCheck(guideline)),
    );
    // a pattern quotes its guideline's own message, so no pack sentence implies it
    const implied = Object.entries(CHECK_SENTENCES).filter(
      ([, shapes]) => Object.keys(shapes).length > 0,
    );
    expect(implied.map(([check]) => check).filter((check) => !owned.has(check))).toEqual([]);
  });

  it("leave every other pack rule marked as judged by the model, and no checked rule marked", () => {
    const wrong = guidelines
      .filter(
        (guideline) => (impliedCheck(guideline) === undefined) !== guideline.tags.includes(JUDGED),
      )
      .map((guideline) => guideline.id);
    expect(wrong).toEqual([]);
  });
});
