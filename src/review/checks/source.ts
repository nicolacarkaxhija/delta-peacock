/** One comment as a reader sees it: consecutive own-line `//` comments form one block. */
export interface CommentBlock {
  /** First and last line, 1-based. */
  start: number;
  end: number;
  /** The words of each line, markers stripped. */
  texts: string[];
  /** A `/* *\/` comment rather than `//` lines. */
  block: boolean;
  /** Code precedes the comment on its first line. */
  trailing: boolean;
}

/** What the checks read of one TypeScript or JavaScript file, without running or fully parsing it. */
export interface SourceScan {
  lines: readonly string[];
  /** Each line with comment, string, template and regex bodies blanked; offsets unchanged. */
  masked: readonly string[];
  comments: readonly CommentBlock[];
  /** Per line: open parens and brackets at its start, counted inside the innermost brace. */
  openAtStart: readonly number[];
  /** Per line: the line of the innermost `{` still open at its start, 0 at top level. */
  braceAtStart: readonly number[];
}

/** The entry at `index`, or the fallback past either end. */
export function item<T>(list: readonly T[], index: number, fallback: T): T {
  return list[index] ?? fallback;
}

/** Tool directives are not prose: they neither join nor count as comments. */
const DIRECTIVE =
  /^(?:eslint[\s-]|eslint$|@ts-|prettier-ignore|istanbul |v8 ignore|c8 ignore|global |jshint|tslint:|\/ <reference|#region|#endregion)/;

/** Keywords after which a slash starts a regex literal. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

interface RawComment {
  start: number;
  end: number;
  block: boolean;
  trailing: boolean;
  text: string;
}

function commentWords(raw: RawComment): string[] {
  if (!raw.block) return [raw.text.replace(/^\/\/+\s?/, "").trim()];
  return raw.text
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*+(?!\/)\s?/, "").trim())
    .filter((line, index, all) => line !== "" || (index > 0 && index < all.length - 1));
}

function isDirective(words: readonly string[]): boolean {
  return words.length === 1 && DIRECTIVE.test(item(words, 0, ""));
}

/** Joins own-line `//` comments on consecutive lines; a directive stands alone. */
function blocksOf(raws: readonly RawComment[]): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  for (const raw of raws) {
    const texts = commentWords(raw);
    if (isDirective(texts)) continue;
    const last = blocks.at(-1);
    if (!raw.block && !raw.trailing && last !== undefined && !last.block && !last.trailing) {
      if (last.end === raw.start - 1) {
        last.end = raw.start;
        last.texts.push(...texts);
        continue;
      }
    }
    blocks.push({
      start: raw.start,
      end: raw.end,
      texts,
      block: raw.block,
      trailing: raw.trailing,
    });
  }
  return blocks;
}

/** Scans a source file once: masks literals and comments, tracks nesting per line. */
export function scanSource(text: string): SourceScan {
  const lines = text.split("\n");
  const out = text.split("");
  const openAtStart: number[] = [0];
  const braceAtStart: number[] = [0];
  const braces: { line: number; base: number }[] = [];
  const raws: RawComment[] = [];
  let paren = 0;
  let line = 1;
  let previous = "";
  let word = "";
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  const newline = (): void => {
    line += 1;
    const top = braces.at(-1);
    openAtStart.push(paren - (top?.base ?? 0));
    braceAtStart.push(top?.line ?? 0);
  };
  const lineHasCodeBefore = (at: number): boolean => {
    for (let back = at - 1; back >= 0 && text[back] !== "\n"; back -= 1) {
      if (!/\s/.test(item(out, back, ""))) return true;
    }
    return false;
  };
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    if (char === "\n") {
      newline();
      at += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", at);
      const end = lineEnd < 0 ? text.length : lineEnd;
      raws.push({
        start: line,
        end: line,
        block: false,
        trailing: lineHasCodeBefore(at),
        text: text.slice(at, end),
      });
      blank(at, end);
      at = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", at + 2);
      const end = close === -1 ? text.length : close + 2;
      const start = line;
      const trailing = lineHasCodeBefore(at);
      blank(at, end);
      for (let scan = at; scan < end; scan += 1) if (text[scan] === "\n") newline();
      raws.push({ start, end: line, block: true, trailing, text: text.slice(at, end) });
      at = end;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      blank(at + 1, Math.min(end, text.length));
      previous = char;
      word = "";
      at = Math.min(end + 1, text.length);
      continue;
    }
    if (char === "`") {
      let end = at + 1;
      let depth = 0;
      while (end < text.length) {
        const inner = text[end];
        if (inner === "\\") {
          end += 2;
          continue;
        }
        if (inner === "\n") newline();
        if (depth === 0 && inner === "`") break;
        if (inner === "$" && text[end + 1] === "{") {
          depth += 1;
          end += 2;
          continue;
        }
        if (depth > 0 && inner === "{") depth += 1;
        if (depth > 0 && inner === "}") depth -= 1;
        end += 1;
      }
      blank(at + 1, Math.min(end, text.length));
      previous = "`";
      word = "";
      at = Math.min(end + 1, text.length);
      continue;
    }
    if (
      char === "/" &&
      (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous) || REGEX_AFTER_WORD.has(word))
    ) {
      let end = at + 1;
      let inClass = false;
      while (end < text.length && text[end] !== "\n") {
        const inner = text[end];
        if (inner === "\\") {
          end += 2;
          continue;
        }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) break;
        end += 1;
      }
      blank(at + 1, Math.min(end, text.length));
      at = Math.min(end + 1, text.length);
      while (at < text.length && /[a-z]/.test(text.charAt(at))) at += 1;
      previous = "/";
      word = "";
      continue;
    }
    if (char === "(" || char === "[") paren += 1;
    else if (char === ")" || char === "]") paren -= 1;
    else if (char === "{") braces.push({ line, base: paren });
    else if (char === "}") braces.pop();
    if (/[A-Za-z0-9_$#]/.test(char)) {
      word = /[A-Za-z0-9_$#]/.test(text.charAt(at - 1)) ? word + char : char;
    } else if (!/\s/.test(char)) word = "";
    if (!/\s/.test(char)) previous = char;
    at += 1;
  }
  const masked = out.join("").split("\n");
  return { lines, masked, comments: blocksOf(raws), openAtStart, braceAtStart };
}

/** Index of the paren closing the one opened at `open` in the joined masked text, or -1. */
export function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let at = open; at < masked.length; at += 1) {
    const char = masked[at];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** Top level comma positions inside `[from, to)` of the joined masked text. */
export function topLevelCommas(masked: string, from: number, to: number): number[] {
  const commas: number[] = [];
  let depth = 0;
  for (let at = from; at < to; at += 1) {
    const char = masked[at];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) commas.push(at);
  }
  return commas;
}

const CONTINUES_FROM_ABOVE = /^(?:[.?:)\]]|&&|\|\||\+|=>)/;
const CONTINUES_BELOW = /(?:[=(,[.+?:]|&&|\|\||=>)$/;

/** The line a statement starts on: up through open parens and operator continuations. */
export function statementStart(scan: SourceScan, line: number): number {
  let start = line;
  for (;;) {
    const current = item(scan.masked, start - 1, "").trim();
    let above = start - 1;
    while (above >= 1 && item(scan.masked, above - 1, "").trim() === "") above -= 1;
    if (above < 1) return start;
    const prior = item(scan.masked, above - 1, "").trim();
    const inside = item(scan.openAtStart, start - 1, 0) > 0;
    if (!inside && !CONTINUES_FROM_ABOVE.test(current) && !CONTINUES_BELOW.test(prior)) {
      return start;
    }
    start = above;
  }
}

/** The comment block whose last line is `line`, own-line only. */
export function commentEndingAt(scan: SourceScan, line: number): CommentBlock | undefined {
  return scan.comments.find((comment) => comment.end === line && !comment.trailing);
}

/** A comment sharing `line` with code. */
export function commentOn(scan: SourceScan, line: number): CommentBlock | undefined {
  return scan.comments.find((comment) => comment.start === line && comment.trailing);
}

/** The comment block covering `line`, when the line is part of one. */
export function commentAt(scan: SourceScan, line: number): CommentBlock | undefined {
  return scan.comments.find(
    (comment) => !comment.trailing && comment.start <= line && line <= comment.end,
  );
}

/** One single-line declaration in a run of them, module or class level. */
const GROUP_MEMBER =
  /^\s*(?:export\s+)?(?:(?:private|protected|public|static|readonly|declare)\s+)*(?:(?:const|let|var)\s+)?#?[\w$]+\s*(?::[^=]+)?=.*;\s*$/;

/** The start of a declaration statement, module, class or function level. */
const DECLARATION =
  /^\s*(?:export\s+)?(?:(?:private|protected|public|static|readonly|declare)\s+)*(?:(?:const|let|var)\s+)?#?[\w$]+\s*(?::[^=]+)?=(?![=>])/;

/**
 * The comments that may carry a line's reason: on the line, just above it,
 * above its statement, heading its group of declarations, and the doc comment
 * of each enclosing function up to the class or module.
 */
export function reasonComments(scan: SourceScan, line: number): CommentBlock[] {
  const found = new Set<CommentBlock>();
  const add = (comment: CommentBlock | undefined): void => {
    if (comment !== undefined) found.add(comment);
  };
  add(commentOn(scan, line));
  add(commentEndingAt(scan, line - 1));
  const start = statementStart(scan, line);
  add(commentEndingAt(scan, start - 1));
  if (GROUP_MEMBER.test(item(scan.lines, start - 1, ""))) {
    let first = start;
    while (first > 1 && GROUP_MEMBER.test(item(scan.lines, first - 2, ""))) first -= 1;
    add(commentEndingAt(scan, first - 1));
    add(commentOn(scan, start));
  } else if (DECLARATION.test(item(scan.masked, start - 1, ""))) {
    // a run of multi-line declarations shares the comment heading it
    let first = start;
    while (
      first > 1 &&
      item(scan.lines, first - 2, "")
        .trim()
        .endsWith(";")
    ) {
      const prior = statementStart(scan, first - 1);
      if (prior >= first || !DECLARATION.test(item(scan.masked, prior - 1, ""))) break;
      first = prior;
    }
    add(commentEndingAt(scan, first - 1));
  }
  let brace = item(scan.braceAtStart, start - 1, 0);
  while (brace > 0) {
    const header = statementStart(scan, brace);
    if (/\bclass\b/.test(item(scan.masked, header - 1, ""))) break;
    add(commentEndingAt(scan, header - 1));
    brace = item(scan.braceAtStart, header - 1, 0);
  }
  return [...found].sort((a, b) => a.start - b.start);
}

/** Offsets of each line's start in the joined text. */
export function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const text of lines) {
    offsets.push(at);
    at += text.length + 1;
  }
  return offsets;
}

/** The 1-based line holding offset `at`. */
export function lineOf(offsets: readonly number[], at: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (item(offsets, middle, 0) <= at) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
