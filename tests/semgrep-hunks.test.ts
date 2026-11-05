import { describe, expect, it } from "vitest";
import { withholdSettled } from "../src/review/semgrep/hunks.js";

const HEADER = (file: string): string =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`;

const FIRST = "@@ -1,2 +1,3 @@\n a\n+chained();\n b\n";
const SECOND = "@@ -10,2 +11,3 @@\n c\n+clean();\n d\n";

const GIFT = `${HEADER("cartridges/gift.js")}${FIRST}${SECOND}`;
const NOTES = `${HEADER("tests/notes.ts")}@@ -1 +1,2 @@\n x\n+y();\n`;

const lines = (entries: [string, number[]][]): Map<string, Set<number>> =>
  new Map(entries.map(([file, numbers]) => [file, new Set(numbers)]));

describe("withholdSettled", () => {
  it("withholds the hunk a rule hit settles and keeps the clean hunk of the same file", () => {
    const out = withholdSettled(GIFT, lines([["cartridges/gift.js", [2]]]), () => true);
    expect(out.diff).toBe(`${HEADER("cartridges/gift.js")}${SECOND}`);
    expect(out.withheld).toEqual([{ file: "cartridges/gift.js", hunk: "@@ -1,2 +1,3 @@" }]);
  });

  it("drops a file whose every hunk is settled, header included", () => {
    const out = withholdSettled(GIFT + NOTES, lines([["cartridges/gift.js", [2, 12]]]), () => true);
    expect(out.diff).toBe(NOTES);
    expect(out.withheld.map((entry) => entry.hunk)).toEqual([
      "@@ -1,2 +1,3 @@",
      "@@ -10,2 +11,3 @@",
    ]);
  });

  it("returns the diff unchanged when no hit lies on an added line", () => {
    const out = withholdSettled(GIFT + NOTES, lines([["cartridges/gift.js", [1, 3]]]), () => true);
    expect(out).toEqual({ diff: GIFT + NOTES, withheld: [] });
  });

  it("keeps a hit hunk of a file the model still judges", () => {
    const out = withholdSettled(
      GIFT,
      lines([["cartridges/gift.js", [2]]]),
      (file) => file !== "cartridges/gift.js",
    );
    expect(out).toEqual({ diff: GIFT, withheld: [] });
  });

  it("counts new lines past deletions and the no newline marker", () => {
    const chunk = `${HEADER("cartridges/gift.js")}@@ -1,3 +1,2 @@\n-old();\n a\n\\ No newline at end of file\n+chained();\n`;
    const out = withholdSettled(chunk, lines([["cartridges/gift.js", [2]]]), () => true);
    expect(out.withheld).toEqual([{ file: "cartridges/gift.js", hunk: "@@ -1,3 +1,2 @@" }]);
  });

  it("keeps a chunk it cannot read a path from", () => {
    const odd = "not a diff\n";
    const out = withholdSettled(odd, lines([]), () => true);
    expect(out).toEqual({ diff: odd, withheld: [] });
  });
});
