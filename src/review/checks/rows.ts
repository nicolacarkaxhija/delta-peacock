import type { Guideline } from "../../domain/guideline.js";
import { appliesTo } from "../../guidelines/languages.js";
import type { Candidate } from "./detect.js";
import { closingParen, item, lineOf, lineOffsets, scanSource } from "./source.js";

/** One test call: where it starts and ends, and its code with every literal abstracted. */
interface TestCall {
  file: string;
  line: number;
  end: number;
  shape: string;
}

const TEST_CALL = /(?<![\w$.])(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?\s*\(/g;

/** Test calls of a file; literals, comments and layout never decide whether two are the same. */
export function testCalls(file: string, text: string): TestCall[] {
  const scan = scanSource(text);
  const joined = scan.masked.join("\n");
  const offsets = lineOffsets(scan.lines);
  const calls: TestCall[] = [];
  for (const match of joined.matchAll(TEST_CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(joined, open);
    if (close < 0) continue;
    const shape = joined
      .slice(match.index, close + 1)
      .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "S")
      .replace(/(?<![\w$])\d[\d_]*(?:\.\d+)?/g, "N")
      .replace(/\s+/g, "");
    // a declaration takes a title and a body; test.slow() inside a body is none
    if (!/^[\w.]+\(S,/.test(shape) || !/=>|function/.test(shape)) continue;
    calls.push({ file, line: lineOf(offsets, match.index), end: lineOf(offsets, close), shape });
  }
  return calls;
}

/** Tests that repeat another test but for its literals; one body looped over rows is one call, never a copy. */
export function rowCandidates(
  guideline: Guideline,
  file: string,
  text: string,
  changed: ReadonlySet<number>,
  read: (file: string) => string | undefined,
  files: () => readonly string[],
): Candidate[] {
  const own = testCalls(file, text);
  if (own.length === 0) return [];
  let others: TestCall[] | undefined;
  const elsewhere = (): TestCall[] => {
    others ??= files()
      .filter((other) => other !== file && appliesTo(guideline, [other]))
      .flatMap((other) => {
        const body = read(other);
        return body === undefined ? [] : testCalls(other, body);
      });
    return others;
  };
  const lines = text.split("\n");
  const found: Candidate[] = [];
  own.forEach((call, index) => {
    let anchor: number | undefined;
    for (let line = call.line; line <= call.end && anchor === undefined; line += 1) {
      if (changed.has(line)) anchor = line;
    }
    if (anchor === undefined) return;
    const original =
      own.slice(0, index).find((earlier) => earlier.shape === call.shape) ??
      elsewhere().find((other) => other.shape === call.shape);
    if (original === undefined) return;
    const where =
      original.file === file
        ? `line ${String(original.line)}`
        : `${original.file} line ${String(original.line)}`;
    found.push({
      guidelineId: guideline.id,
      check: "rows",
      shape: "copy",
      file,
      line: call.line,
      quote: item(lines, call.line - 1, ""),
      title: "Test copies another but for its literals",
      body: `This test repeats the one at ${where} with only its literals changed. Make them one scenario with data rows: keep one test body and loop over the rows, such as \`\` for (const row of rows) { test(\`... \${row.name}\`, ...) } \`\`.`,
    });
  });
  return found;
}
