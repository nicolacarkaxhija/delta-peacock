import { describe, expect, it } from "vitest";
import {
  closingParen,
  commentAt,
  item,
  lineOf,
  lineOffsets,
  reasonComments,
  scanSource,
  statementStart,
  topLevelCommas,
} from "../src/review/checks/source.js";

const PAGE = [
  "import type { Locator } from '@playwright/test';",
  "",
  "/** The fit guide's own hooks, after the storefront dropped its two test ids. */",
  "const SIZE_GUIDE_TRIGGER = 'button.b-product_fit_guide-link';",
  "const SIZE_GUIDE_PANEL = 'div.b-drawer.m-fit_guide';",
  "",
  "/** The page. */",
  "export class PdpPage extends BasePage {",
  "  /** Every image the carousel holds. */",
  "  productImages(): Locator {",
  "    // the tag selector",
  "    return this.page",
  "      .getByTestId('gallery')",
  "      .locator('img'); // trailing words",
  "  }",
  "}",
].join("\n");

describe("the source scan", () => {
  it("blanks strings, templates, regexes and comments but keeps offsets and lines", () => {
    const text = [
      'const a = \'x // y\'; const b = "q\\"(";',
      "const c = `t ${d('(')} u`;",
      "const r = /[/(]x/gi; const s = a / b;",
      "return /)/.test(s);",
      "/* one",
      "   two */ call(1);",
    ].join("\n");
    const scan = scanSource(text);
    expect(scan.masked.map((line) => line.length)).toEqual(scan.lines.map((line) => line.length));
    expect(scan.masked[0]).toBe("const a = '      '; const b = \"    \";");
    expect(scan.masked[1]).not.toContain("(");
    expect(scan.masked[2]).toContain("const s = a / b;");
    expect(scan.masked[2]).not.toContain("(");
    expect(scan.masked[3]).toBe("return / /.test(s);");
    expect(scan.masked[5]).toBe("          call(1);");
    expect(scan.comments).toEqual([
      { start: 5, end: 6, texts: ["one", "two"], block: true, trailing: false },
    ]);
  });

  it("joins own-line line comments, keeps trailing ones and doc blocks apart, skips directives", () => {
    const text = [
      "// first half,",
      "// second half.",
      "call(); // trailing",
      "// eslint-disable-next-line no-console",
      "// alone",
      "/**",
      " * doc",
      " */",
      "",
      "// after a gap",
    ].join("\n");
    const { comments } = scanSource(text);
    expect(comments.map((comment) => [comment.start, comment.end, comment.texts])).toEqual([
      [1, 2, ["first half,", "second half."]],
      [3, 3, ["trailing"]],
      [5, 5, ["alone"]],
      [6, 8, ["doc"]],
      [10, 10, ["after a gap"]],
    ]);
    expect(comments[1]?.trailing).toBe(true);
  });

  it("tracks the innermost brace and open parens at each line start", () => {
    const scan = scanSource(
      ["test(", "  'a',", "  async () => {", "    go();", "  },", ");"].join("\n"),
    );
    expect(scan.openAtStart).toEqual([0, 1, 1, 0, 0, 1]);
    expect(scan.braceAtStart).toEqual([0, 0, 0, 3, 3, 0]);
  });

  it("finds where a statement starts across chains, open parens and operators", () => {
    const scan = scanSource(PAGE);
    expect(statementStart(scan, 14)).toBe(12);
    expect(statementStart(scan, 12)).toBe(12);
    expect(statementStart(scan, 1)).toBe(1);
    const math = scanSource(["const a =", "  1 +", "  2;", "", "b();"].join("\n"));
    expect(statementStart(math, 3)).toBe(1);
    expect(statementStart(math, 5)).toBe(5);
  });

  it("collects the comments that may carry a reason for a line", () => {
    const scan = scanSource(PAGE);
    const words = (line: number): string[] =>
      reasonComments(scan, line).map((comment) => comment.texts.join(" "));
    expect(words(14)).toEqual([
      "Every image the carousel holds.",
      "the tag selector",
      "trailing words",
    ]);
    expect(words(5)).toEqual([
      "The fit guide's own hooks, after the storefront dropped its two test ids.",
    ]);
    expect(words(4)).toEqual([
      "The fit guide's own hooks, after the storefront dropped its two test ids.",
    ]);
    expect(commentAt(scan, 3)?.start).toBe(3);
    expect(commentAt(scan, 4)).toBeUndefined();
  });

  it("matches parens, splits top level commas and maps offsets to lines", () => {
    const masked = "f(a, g(b, c), [d, e])";
    expect(closingParen(masked, 1)).toBe(masked.length - 1);
    expect(closingParen("f(a", 1)).toBe(-1);
    expect(topLevelCommas(masked, 2, masked.length - 1)).toEqual([3, 12]);
    const offsets = lineOffsets(["ab", "c", "def"]);
    expect(offsets).toEqual([0, 3, 5]);
    expect(lineOf(offsets, 0)).toBe(1);
    expect(lineOf(offsets, 4)).toBe(2);
    expect(lineOf(offsets, 7)).toBe(3);
  });

  it("keeps a template's escapes and nested braces inside the template", () => {
    const scan = scanSource("const t = `a \\` ${ { b: 1 }.b } c`; f(1);");
    expect(scan.masked[0]?.endsWith("; f(1);")).toBe(true);
    expect(scan.masked[0]).not.toContain("{");
    expect(item([1], 3, 0)).toBe(0);
    expect(item([1], 0, 0)).toBe(1);
  });

  it("survives an unterminated block comment, string and template", () => {
    expect(scanSource("a(); /* open").comments).toHaveLength(1);
    expect(scanSource("const a = 'open\nb();").masked[1]).toBe("b();");
    expect(scanSource("const a = `open\n${x}\n").masked).toHaveLength(3);
    expect(scanSource("const r = /\\/[a]/;").masked[0]).toBe("const r = /     /;");
  });
});
