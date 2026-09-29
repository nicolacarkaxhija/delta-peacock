import type { Guideline } from "../../domain/guideline.js";
import type { Candidate } from "./detect.js";
import { item, reasonComments, scanSource, type CommentBlock } from "./source.js";

/** One numeric literal in code, a regex quantifier included. */
export interface NumberLiteral {
  line: number;
  /** Column of its first character on the line. */
  column: number;
  text: string;
}

const NUMBER =
  /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/;
const QUANTIFIER = /\{(\d+)(?:,(\d*))?\}/g;
const WORD = /[A-Za-z0-9_$#]/;
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

/** Numeric literals in code outside comments and strings, template expressions and regex quantifiers included. */
export function numberLiterals(text: string): NumberLiteral[] {
  const found: NumberLiteral[] = [];
  let line = 1;
  let lineStart = 0;
  let previous = "";
  let word = "";
  // one entry per open template expression: the brace depth inside it
  const templates: number[] = [];
  const push = (at: number, literal: string): void => {
    found.push({ line, column: at - lineStart, text: literal });
  };
  const newlines = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (text[at] === "\n") {
        line += 1;
        lineStart = at + 1;
      }
    }
  };
  // scans a template body from `at` to its closing backtick or an opening ${
  const templateBody = (from: number): number => {
    let at = from;
    while (at < text.length) {
      const char = text[at];
      if (char === "\\") {
        at += 2;
        continue;
      }
      if (char === "`") return at + 1;
      if (char === "$" && text[at + 1] === "{") {
        templates.push(0);
        return at + 2;
      }
      at += 1;
    }
    return at;
  };
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    if (char === "\n") {
      line += 1;
      lineStart = at + 1;
      at += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", at + 2);
      const end = close < 0 ? text.length : close + 2;
      newlines(at, end);
      at = end;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      at = Math.min(end + 1, text.length);
      previous = char;
      word = "";
      continue;
    }
    if (char === "`") {
      const end = templateBody(at + 1);
      newlines(at, end);
      at = end;
      previous = "`";
      word = "";
      continue;
    }
    if (templates.length > 0 && char === "{") {
      templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + 1;
    }
    if (templates.length > 0 && char === "}") {
      const depth = templates[templates.length - 1] ?? 0;
      if (depth === 0) {
        templates.pop();
        const end = templateBody(at + 1);
        newlines(at, end);
        at = end;
        previous = "`";
        word = "";
        continue;
      }
      templates[templates.length - 1] = depth - 1;
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
      const body = text.slice(at + 1, end);
      for (const match of body.matchAll(QUANTIFIER)) {
        push(at + 1 + match.index + 1, String(match[1]));
        if (match[2] !== undefined && match[2] !== "") {
          push(at + 1 + match.index + 2 + String(match[1]).length, match[2]);
        }
      }
      at = Math.min(end + 1, text.length);
      while (at < text.length && /[a-z]/.test(text.charAt(at))) at += 1;
      previous = "/";
      word = "";
      continue;
    }
    if (/[\d.]/.test(char) && !WORD.test(text.charAt(at - 1))) {
      const match = NUMBER.exec(text.slice(at));
      if (match !== null && (char !== "." || /\d/.test(next))) {
        push(at, match[0]);
        at += match[0].length;
        previous = "0";
        word = "";
        continue;
      }
    }
    if (WORD.test(char)) word = WORD.test(text.charAt(at - 1)) ? word + char : char;
    else if (!/\s/.test(char)) word = "";
    if (!/\s/.test(char)) previous = char;
    at += 1;
  }
  return found;
}

/** The numeric literals of a shell script outside comments and single quotes; positional parameters and redirects left out. */
export function shellNumberLiterals(text: string): NumberLiteral[] {
  const found: NumberLiteral[] = [];
  text.split("\n").forEach((raw, index) => {
    let code = "";
    let quote = "";
    for (let at = 0; at < raw.length; at += 1) {
      const char = raw.charAt(at);
      if (quote === "'") {
        code += char === "'" ? "'" : " ";
        if (char === "'") quote = "";
        continue;
      }
      if (char === "\\") {
        code += "  ";
        at += 1;
        continue;
      }
      if (char === '"') quote = quote === '"' ? "" : '"';
      else if (char === "'" && quote === "") quote = "'";
      else if (char === "#" && quote === "" && (at === 0 || /\s/.test(raw.charAt(at - 1)))) break;
      code += char;
    }
    for (const match of code.matchAll(/(?<![\w$.#])\d+(?![\w.])/g)) {
      const before = code.slice(0, match.index);
      const after = code.slice(match.index + match[0].length);
      if (/\$\{?$/.test(before) || /^\s*>|^\s*</.test(after) || /[<>]&?\s*$/.test(before)) continue;
      found.push({ line: index + 1, column: match.index, text: match[0] });
    }
  });
  return found;
}

const KIND_HELP =
  "how long the code waits (a timeout or delay), how often it tries again (a retry count), or where it stops, cuts or switches (a limit or threshold, such as a maximum, a minimum, a length it cuts at or matches, or how many lines, items or bytes it reads)";
const NOT_KINDS =
  "A status code, an exit code, a count of decimal places or a unit factor is none of them.";
const KINDS = ["timeout", "delay", "retry count", "limit", "threshold"] as const;

/** Zero, one and minus one are plain arithmetic. */
function isPlain(literal: string): boolean {
  const value = Number(literal.replace(/_/g, "").replace(/n$/, ""));
  return value === 0 || value === 1;
}

/** A conversion between units, such as seconds to milliseconds: none of the kinds the rule names. */
const UNIT_FACTORS = new Set([60, 24, 7, 100, 1000, 1024, 3600, 86_400, 1_000_000]);

function isUnitFactor(line: string, literal: NumberLiteral): boolean {
  const value = Number(literal.text.replace(/_/g, ""));
  if (!UNIT_FACTORS.has(value)) return false;
  const before = line.slice(0, literal.column).trimEnd();
  const after = line.slice(literal.column + literal.text.length).trimStart();
  return /[*/]$/.test(before) || /^[*/](?!\/)/.test(after);
}

/** A formatting argument: decimal places, a pad width or a radix. */
function isFormatArgument(line: string, literal: NumberLiteral): boolean {
  const before = line.slice(0, literal.column);
  return /\.(?:toFixed|toPrecision|toExponential|padStart|padEnd|toString)\(\s*$/.test(before);
}

/** An index into a list: `parts[2]`. */
function isIndex(line: string, literal: NumberLiteral): boolean {
  const before = line.slice(0, literal.column);
  const after = line.slice(literal.column + literal.text.length);
  return /[\w$)\]]\s*\[\s*$/.test(before) && /^\s*\]/.test(after);
}

/** A declaration naming a numeric value: `const NAME = 4;`, a class field, or `name=4` in shell. */
const TS_CONSTANT =
  /^\s*(?:export\s+)?(?:(?:private|protected|public|static|readonly|declare)\s+)*(?:(?:const|let|var)\s+)?#?([\w$]+)\s*(?::[^=]+)?=\s*([-+*/%()\s\d._xXa-fA-FeEn]+?)\s*;?\s*$/;
const SHELL_CONSTANT =
  /^\s*(?:readonly\s+|local\s+|export\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=(\d[\d_]*)\s*$/;

/** A name that says it converts units, such as seconds_per_day or MS_PER_SECOND. */
const PER = /(?:^|_)per(?:_|$)|[a-z\d]Per[A-Z\d]/i;

function constantName(line: string, shell: boolean): string | undefined {
  const match = (shell ? SHELL_CONSTANT : TS_CONSTANT).exec(line);
  if (match === null) return undefined;
  const init = String(match[2]);
  if (!shell && !/\d/.test(init)) return undefined;
  if (!shell && /[a-df-wyzA-DF-WYZ]/.test(init.replace(/0[xX][\da-fA-F_]+/g, ""))) return undefined;
  return match[1];
}

/** A document, page or standard a value can follow: a docs file, a URL, an RFC or ISO number. */
const SOURCE =
  /(?:^|[\s(`'"])[\w./-]*[\w-]\.(?:md|mdx|rst|adoc|txt|pdf|html?)\b|https?:\/\/\S+|\b(?:RFC|ISO|IEC|ECMA|IEEE)[\s-]?\d+/i;
/** Words that tie a named source to the value, so a comment only mentioning a file does not count. */
const FOLLOWS =
  /\b(?:sets?|says?|asks?|requires?|defines?|specif(?:y|ies)|follows?|allows?|caps?|limits?|per|from|see|according)\b/i;
/** What a smaller or larger value fails to do: "long enough to", "short enough for", "too slow". */
const BOUND =
  /\benough\b[^.;:]*?\b(?:to|for)\b|\btoo\s+(?:long|short|big|small|large|many|few|slow|fast|high|low|wide|narrow)\b/i;

/** A comment sentence that is the reason by the guideline's own words: the source that sets the value, or the bound it keeps. */
export function statesReason(comment: string): boolean {
  return comment
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => (SOURCE.test(sentence) && FOLLOWS.test(sentence)) || BOUND.test(sentence));
}

const code = (text: string): string => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``);
const words = (comment: CommentBlock): string => comment.texts.join(" ").trim();

function shellComments(lines: readonly string[], line: number): CommentBlock[] {
  const above: string[] = [];
  for (let at = line - 1; at >= 1; at -= 1) {
    const text = item(lines, at - 1, "").trim();
    if (!text.startsWith("#") || text.startsWith("#!")) break;
    above.unshift(text.replace(/^#+\s?/, ""));
  }
  const own = /\s#\s?(.*)$/.exec(item(lines, line - 1, ""));
  const found: CommentBlock[] = [];
  if (above.length > 0) {
    found.push({
      start: line - above.length,
      end: line - 1,
      texts: above,
      block: false,
      trailing: false,
    });
  }
  if (own?.[1] !== undefined) {
    found.push({ start: line, end: line, texts: [own[1]], block: false, trailing: true });
  }
  return found;
}

/** Inline numbers and named numeric constants the rule may cover; the judge settles what they are and whether a comment gives the reason. */
export function numberCandidates(
  guideline: Guideline,
  file: string,
  text: string,
  changed: ReadonlySet<number>,
): Candidate[] {
  const shell = /\.(?:sh|bash)$/.test(file);
  const lines = text.split("\n");
  const scan = shell ? undefined : scanSource(text);
  const literals = shell ? shellNumberLiterals(text) : numberLiterals(text);
  const byLine = new Map<number, NumberLiteral[]>();
  for (const literal of literals) {
    if (!changed.has(literal.line) || isPlain(literal.text)) continue;
    const source = item(lines, literal.line - 1, "");
    if (isUnitFactor(source, literal) || isIndex(source, literal)) continue;
    if (isFormatArgument(source, literal)) continue;
    byLine.set(literal.line, [...(byLine.get(literal.line) ?? []), literal]);
  }
  const found: Candidate[] = [];
  const base = { guidelineId: guideline.id, check: "numbers" as const, file };
  for (const [line, numbers] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const quote = item(lines, line - 1, "");
    const listed = [...new Set(numbers.map((one) => one.text))];
    const bare = shell ? quote.replace(/\s#.*$/, "") : item(scan?.masked ?? [], line - 1, "");
    const name = constantName(bare, shell);
    const comments = (
      shell ? shellComments(lines, line) : reasonComments(scan ?? scanSource(text), line)
    ).filter((comment) => words(comment) !== "");
    if (name !== undefined) {
      if (PER.test(name)) continue;
      if (comments.some((comment) => statesReason(words(comment)))) continue;
      found.push({
        ...base,
        shape: "unexplained-constant",
        line,
        quote,
        title: `No reason next to ${name}`,
        body: `${code(name)} names ${code(listed.join(", "))}, and no comment next to it says why it has that value. Add one short comment above it with the reason.`,
        judge: {
          question: `Does this value set ${KIND_HELP}? ${NOT_KINDS} If it is one of them, test each listed comment: remove the constant's name and its value from your mind and ask whether the comment still tells a reader why the number is this size and not another, through a cause, a measurement, a comparison, or an outside rule, service or document it follows. A comment that only says what the value counts, measures or is used for gives no reason for its size: confirm. Drop only on a comment that gives the reason.`,
          comments: comments.map((comment) => ({ line: comment.start, text: words(comment) })),
          fact: `${code(name)} has no comment saying why it is ${code(listed.join(", "))}.`,
          fix: "Add one short comment above it with the reason.",
          kinds: KINDS,
        },
      });
      continue;
    }
    found.push({
      ...base,
      shape: "inline-number",
      line,
      quote,
      title: `Inline number ${listed.join(", ")}`,
      body: `${code(listed.join(", "))} is written inline. Name it once as a constant, next to a comment with the reason it has that value, and use the name here.`,
      judge: {
        question: `Does one of the numbers ${listed.map((one) => code(one)).join(", ")} on the flagged line set ${KIND_HELP}? ${NOT_KINDS} An inline number of these kinds is never settled by a comment, so confirm it.`,
        comments: [],
        fact: `${code(listed.join(", "))} is written inline.`,
        fix: "Name it once as a constant, next to a comment with the reason it has that value, and use the name here.",
        kinds: KINDS,
      },
    });
  }
  return found;
}
