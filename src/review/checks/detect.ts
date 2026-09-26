import { GUIDELINE_CHECKS, type Guideline, type GuidelineCheck } from "../../domain/guideline.js";
import { appliesTo } from "../../guidelines/languages.js";
import type { DeclaredTags } from "../declared.js";
import {
  closingParen,
  item,
  lineOf,
  lineOffsets,
  reasonComments,
  scanSource,
  statementStart,
  topLevelCommas,
  type CommentBlock,
  type SourceScan,
} from "./source.js";

/** The static checks a guideline can be bound to in `review.checks`. */
export const CHECKS = GUIDELINE_CHECKS;
export type CheckName = GuidelineCheck;

export type Shape =
  | "test-id"
  | "test-id-list"
  | "css"
  | "multi-line"
  | "dash"
  | "narration"
  | "snapshot"
  | "undeclared-tag"
  | "title-tag";

/** A line a static check found; the only way a checked guideline yields a finding. */
export interface Candidate {
  guidelineId: string;
  check: CheckName;
  shape: Shape;
  file: string;
  line: number;
  /** The flagged line as the file holds it. */
  quote: string;
  title: string;
  /** What was measured, then the fix the catalog names for this shape. */
  body: string;
  /** A replacement for the flagged line, only where the catalog can write one. */
  suggestion?: string;
  /** The replacement form the fix names, such as `toHaveURL`; model text naming another is dropped. */
  form?: string;
  /** Set when prose decides: the comments a judge reads before it may drop the candidate. */
  judge?: {
    question: string;
    comments: { line: number; text: string }[];
    /** The body around a confirmed judge's own reason: the measured fact, then the fix. */
    fact: string;
    fix: string;
  };
}

export interface CheckContext {
  /** Added line numbers per changed file. */
  changed: ReadonlyMap<string, ReadonlySet<number>>;
  /** A file's text at the reviewed commit; undefined when unreadable. */
  read: (file: string) => string | undefined;
  /** The repository's files, for following a page object method to its body. */
  files: () => readonly string[];
  declared?: DeclaredTags;
  /** The attribute getByTestId reads. */
  testIdAttribute: string;
}

export interface BoundGuideline {
  guideline: Guideline;
  check: CheckName;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Words that name why a selector is the best available: the locator vocabulary and a because. */
const REASON =
  /\btest[ -]?ids?\b|\bdata-[a-z][\w-]*|\bgetBy[A-Z]\w*|\broles?\b|\bclass(?:es|names?)?\b|\battributes?\b|\bshadow\b|\bbecause\b|\bsince\b|\bcannot\b|\bcan't\b|\bno [a-z]+|\bwithout\b/i;

/** A dash used as punctuation: spaced hyphens, double hyphens, en and em dashes. */
const DASH = /\s(?:-{1,2}|\u2013|\u2014)(?:\s|$)|\w-{2}\w|[\u2013\u2014]/;

/** Wording that tells the story of the change instead of the code. */
const NARRATION =
  /\b(?:(?:i|we) (?:fixed|tried|changed|added|removed)|fixed (?:this|it|that)|tried (?:\w+ )?(?:selectors?|first|again)|finally works|now (?:it )?works|debugg(?:ed|ing)|this session|the chat|this (?:change|commit|pr|pull request)|as discussed|as requested|before it was)\b/i;

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
const codeSpan = (text: string): string => `\`\` ${text} \`\``;
const wordsOf = (comment: CommentBlock): string => comment.texts.join(" ").trim();

interface Parsed {
  scan: SourceScan;
  joined: string;
  original: string;
  offsets: number[];
}

function parse(text: string): Parsed {
  const scan = scanSource(text);
  return {
    scan,
    joined: scan.masked.join("\n"),
    original: text,
    offsets: lineOffsets(scan.lines),
  };
}

function isChanged(changed: ReadonlySet<number>, from: number, to: number): boolean {
  for (let line = from; line <= to; line += 1) if (changed.has(line)) return true;
  return false;
}

function firstChanged(changed: ReadonlySet<number>, from: number, to: number): number | undefined {
  for (let line = from; line <= to; line += 1) if (changed.has(line)) return line;
  return undefined;
}

function reasonGiven(comments: readonly CommentBlock[]): boolean {
  return comments.some((comment) => REASON.test(wordsOf(comment)));
}

// selectors

interface Selector {
  kind: "test-id" | "test-id-list" | "css" | "derived" | "unknown";
  /** The test id expression, quoted or a name, for a single test id. */
  id?: string;
  /** The source of the ids, for a list. */
  ids?: string;
  /** Declaration lines whose comments may carry the reason. */
  declarations: number[];
  /** A module level constant this selector is, when it is exactly one. */
  constant?: number;
}

const HELPER = /^(?:this\s*\.\s*)?#?(\w*(?:hook|testid)\w*selector)\s*\(([\s\S]*)\)$/i;
const STRING = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$|^`([^`$]*)`$/;
const LIST =
  /^([\w$.]+|\[[^\]]*\])\s*\.\s*map\s*\(\s*\(?\s*[\w$]+\s*\)?\s*=>\s*([\s\S]*?)\)\s*\.\s*join\s*\(/;

function stringValue(text: string): string | undefined {
  const match = STRING.exec(text.trim());
  if (match === null) return undefined;
  return match[2] ?? match[3];
}

function classifyString(value: string, attribute: string): Selector {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plain = new RegExp(`^\\[(?:${escaped}|data-testid)=["']?([^"'\\]]+)["']?\\]$`).exec(
    value.trim(),
  );
  return plain !== null
    ? { kind: "test-id", id: `'${String(plain[1])}'`, declarations: [] }
    : { kind: "css", declarations: [] };
}

function classifyHelper(args: string): Selector {
  if (/\bsuffix\s*:/.test(args)) return { kind: "derived", declarations: [] };
  const value = /\bvalue\s*:\s*((['"])[^'"]*\2|[\w$.]+)/.exec(args);
  if (value?.[1] !== undefined) return { kind: "test-id", id: value[1], declarations: [] };
  if (/\{\s*value\s*\}/.test(args)) return { kind: "test-id", id: "value", declarations: [] };
  return { kind: "unknown", declarations: [] };
}

/** The declaration of `name` visible from `line`: its line and its initializer. */
function declarationOf(
  parsed: Parsed,
  name: string,
  line: number,
): { line: number; init: string; local: boolean } | undefined {
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:private|protected|public|static|readonly)\\s+)*(?:(?:const|let|var)\\s+)?#?${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=(?!=)`,
  );
  const { scan } = parsed;
  const home = item(scan.braceAtStart, statementStart(scan, line) - 1, 0);
  let found: { line: number; local: boolean } | undefined;
  for (let at = 1; at <= scan.lines.length; at += 1) {
    if (!pattern.test(item(scan.masked, at - 1, ""))) continue;
    const brace = item(scan.braceAtStart, at - 1, 0);
    const local = brace !== 0 && brace === home && at < line;
    const level =
      brace === 0 || /\bclass\b/.test(item(scan.masked, statementStart(scan, brace) - 1, ""));
    if (local) found = { line: at, local: true };
    else if (level && found === undefined) found = { line: at, local: false };
  }
  if (found === undefined) return undefined;
  const start =
    item(parsed.offsets, found.line - 1, 0) +
    item(scan.masked, found.line - 1, "").indexOf("=") +
    1;
  let end = start;
  let depth = 0;
  while (end < parsed.joined.length) {
    const char = parsed.joined[end];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth < 0 || (depth === 0 && char === ";")) break;
    end += 1;
  }
  return { ...found, init: parsed.original.slice(start, end).trim() };
}

function splitPlus(parsed: Parsed, from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let at = from; at < to; at += 1) {
    const char = parsed.joined[at];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "+" && depth === 0) {
      parts.push([start, at]);
      start = at + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

function classifyExpression(
  parsed: Parsed,
  from: number,
  to: number,
  line: number,
  attribute: string,
  depth = 0,
): Selector {
  const text = parsed.original.slice(from, to).trim();
  const pieces = splitPlus(parsed, from, to);
  if (pieces.length > 1) {
    const kinds = pieces.map(([start, end]) =>
      classifyExpression(parsed, start, end, line, attribute, depth + 1),
    );
    const declarations = kinds.flatMap((kind) => kind.declarations);
    if (kinds.some((kind) => kind.kind === "css" || kind.kind === "unknown")) {
      return { kind: "css", declarations };
    }
    return {
      kind: kinds.some((kind) => kind.kind === "derived") ? "derived" : "css",
      declarations,
    };
  }
  const value = stringValue(text);
  if (value !== undefined) return classifyString(value, attribute);
  const helper = HELPER.exec(text);
  if (helper !== null) return classifyHelper(String(helper[2]));
  const list = LIST.exec(text);
  if (list !== null) {
    const inner = HELPER.exec(String(list[2]).trim());
    if (inner !== null && classifyHelper(String(inner[2])).kind === "test-id") {
      return { kind: "test-id-list", ids: String(list[1]), declarations: [] };
    }
    return { kind: "css", declarations: [] };
  }
  const name = /^(?:this\s*\.\s*#?|[A-Z][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(text)?.[1];
  if (name !== undefined && depth < 3) {
    const declaration = declarationOf(parsed, name, line);
    if (declaration === undefined) return { kind: "unknown", declarations: [] };
    const initStart = parsed.original.indexOf(
      declaration.init,
      item(parsed.offsets, declaration.line - 1, 0),
    );
    const inner = classifyExpression(
      parsed,
      initStart,
      initStart + declaration.init.length,
      declaration.line,
      attribute,
      depth + 1,
    );
    return {
      ...inner,
      declarations: [declaration.line, ...inner.declarations],
      ...(declaration.local ? {} : { constant: declaration.line }),
    };
  }
  return { kind: "unknown", declarations: [] };
}

function selectorCandidates(
  guideline: Guideline,
  file: string,
  parsed: Parsed,
  changed: ReadonlySet<number>,
  context: CheckContext,
): Candidate[] {
  const { scan, joined, offsets } = parsed;
  const found: Candidate[] = [];
  for (const match of joined.matchAll(/\.\s*locator\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(joined, open);
    if (close < 0) continue;
    const argEnd = topLevelCommas(joined, open + 1, close)[0] ?? close;
    const useLine = lineOf(offsets, match.index);
    const lastLine = lineOf(offsets, argEnd);
    const selector = classifyExpression(parsed, open + 1, argEnd, useLine, context.testIdAttribute);
    if (selector.kind === "derived" || selector.kind === "unknown") continue;
    // a constant used alone takes the finding on its own changed declaration
    const constant = selector.declarations.length === 1 ? selector.constant : undefined;
    const site = constant !== undefined && changed.has(constant) ? constant : useLine;
    if (site === useLine && !isChanged(changed, useLine, lastLine)) continue;
    const comments = [
      ...reasonComments(scan, useLine),
      ...selector.declarations.flatMap((line) => reasonComments(scan, line)),
    ];
    if (reasonGiven(comments)) continue;
    const quote = item(scan.lines, site - 1, "");
    const expression = parsed.original
      .slice(open + 1, argEnd)
      .trim()
      .replace(/\s+/g, " ");
    const base = {
      guidelineId: guideline.id,
      check: "selectors" as const,
      file,
      line: site,
      quote,
    };
    if (selector.kind === "test-id") {
      const id = String(selector.id);
      const lineStart = item(offsets, useLine - 1, 0);
      const oneLine = site === useLine && lineOf(offsets, close) === useLine;
      const suggestion = oneLine
        ? `${quote.slice(0, match.index - lineStart)}.getByTestId(${id})${quote.slice(close - lineStart + 1)}`
        : undefined;
      found.push({
        ...base,
        shape: "test-id",
        title: "Plain test id selected through CSS",
        body: `${code(expression)} selects the test id ${code(id)} through a CSS selector, and no comment says why. getByTestId reads the same attribute: use ${code(`getByTestId(${id})`)}.`,
        form: "getByTestId",
        ...(suggestion !== undefined ? { suggestion } : {}),
      });
      continue;
    }
    if (selector.kind === "test-id-list") {
      const ids = String(selector.ids);
      const source = ids.startsWith("[")
        ? `/^(${[...ids.matchAll(/['"]([^'"]+)['"]/g)].map((one) => one[1]).join("|")})$/`
        : `new RegExp(\`^(\${${ids}.join('|')})$\`)`;
      found.push({
        ...base,
        shape: "test-id-list",
        title: "Test ids joined into a CSS selector list",
        body: `${code(expression)} joins plain test ids into one CSS selector list, and no comment says why. getByTestId reads the same ids: match them with one regex, such as ${codeSpan(`getByTestId(${source})`)}, or join single getByTestId calls with or().`,
        form: "getByTestId",
      });
      continue;
    }
    const prose = comments.filter((comment) => wordsOf(comment) !== "");
    const fix =
      "Use getByTestId or getByRole with a name where the element offers one; otherwise add one short comment saying why CSS is needed.";
    found.push({
      ...base,
      shape: "css",
      title: "CSS selector without a reason",
      body: `${code(expression)} is a CSS selector, and no comment on the line, above it or on its declaration says why nothing better exists. ${fix}`,
      ...(prose.length > 0
        ? {
            judge: {
              question:
                "Does one of these comments say why a test id, or a role with a name, cannot address this element? A comment that only says what the element is or does gives no reason.",
              comments: [...new Set(prose)].map((comment) => ({
                line: comment.start,
                text: wordsOf(comment),
              })),
              fact: `${code(expression)} is a CSS selector.`,
              fix,
            },
          }
        : {}),
    });
  }
  return found;
}

// comments

function folded(scan: SourceScan, comment: CommentBlock): string {
  const first = item(scan.lines, comment.start - 1, "");
  const indent = first.slice(0, first.length - first.trimStart().length);
  const words = wordsOf(comment);
  const doc = item(scan.lines, comment.start - 1, "")
    .trim()
    .startsWith("/**");
  return comment.block ? `${indent}${doc ? "/**" : "/*"} ${words} */` : `${indent}// ${words}`;
}

function withoutDash(line: string): string {
  const at = line.includes("//") ? line.indexOf("//") : line.indexOf("/*");
  const head = line.slice(0, Math.max(0, at));
  const tail = line
    .slice(Math.max(0, at))
    .replace(/\s+(?:-{1,2}|\u2013|\u2014)\s+/g, ", ")
    .replace(/(\w)-{2}(\w)/g, "$1, $2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ");
  return head + tail;
}

function commentCandidates(
  guideline: Guideline,
  file: string,
  parsed: Parsed,
  changed: ReadonlySet<number>,
): Candidate[] {
  const { scan } = parsed;
  const found: Candidate[] = [];
  for (const comment of scan.comments) {
    const anchor = firstChanged(changed, comment.start, comment.end);
    if (anchor === undefined) continue;
    const base = { guidelineId: guideline.id, check: "comments" as const, file };
    if (comment.end > comment.start) {
      const lines = comment.end - comment.start + 1;
      found.push({
        ...base,
        shape: "multi-line",
        line: anchor,
        quote: item(scan.lines, anchor - 1, ""),
        title: `Comment spans ${String(lines)} lines`,
        body: `This comment spans ${String(lines)} lines; the guideline asks for one line. Fold it into one short line that keeps its reason, such as ${codeSpan(folded(scan, comment).trim())}.`,
      });
      continue;
    }
    const text = wordsOf(comment).replace(/`[^`]*`/g, "");
    if (DASH.test(` ${text} `.replace(/^\s-\s/, " "))) {
      const quote = item(scan.lines, anchor - 1, "");
      const suggestion = withoutDash(quote);
      found.push({
        ...base,
        shape: "dash",
        line: anchor,
        quote,
        title: "Dash in a comment",
        body: "The comment uses a dash as punctuation; the guideline asks for commas or colons instead.",
        ...(suggestion !== quote ? { suggestion } : {}),
      });
      continue;
    }
    if (NARRATION.test(text)) {
      found.push({
        ...base,
        shape: "narration",
        line: anchor,
        quote: item(scan.lines, anchor - 1, ""),
        title: "Comment narrates the change",
        body: "The comment tells the story of the change rather than what the code cannot say. Keep only the present reason, or drop the comment.",
        judge: {
          question:
            "Does this comment narrate the change, the session or the author, rather than state a present reason or fact about the code?",
          comments: [{ line: comment.start, text: wordsOf(comment) }],
          fact: "The comment tells the story of the change.",
          fix: "Keep only the present reason, or drop the comment.",
        },
      });
    }
  }
  return found;
}

// assertions

type ReadKind =
  | "url"
  | "visible"
  | "hidden"
  | "enabled"
  | "disabled"
  | "checked"
  | "editable"
  | "text"
  | "value"
  | "attribute"
  | "count"
  | "title";

const GETTERS: Readonly<Record<string, ReadKind>> = {
  isVisible: "visible",
  isHidden: "hidden",
  isEnabled: "enabled",
  isDisabled: "disabled",
  isChecked: "checked",
  isEditable: "editable",
  textContent: "text",
  innerText: "text",
  innerHTML: "text",
  allTextContents: "text",
  allInnerTexts: "text",
  inputValue: "value",
  getAttribute: "attribute",
  count: "count",
  url: "url",
  title: "title",
};

/** The web-first matcher for each read, and how the reading is named in prose. */
const WEB_FIRST: Readonly<Record<ReadKind, { what: string; on: string; call: string }>> = {
  url: { what: "URL", on: "page", call: "toHaveURL(...)" },
  title: { what: "title", on: "page", call: "toHaveTitle(...)" },
  visible: { what: "visibility", on: "locator", call: "toBeVisible()" },
  hidden: { what: "visibility", on: "locator", call: "toBeHidden()" },
  enabled: { what: "enabled state", on: "locator", call: "toBeEnabled()" },
  disabled: { what: "disabled state", on: "locator", call: "toBeDisabled()" },
  checked: { what: "checked state", on: "locator", call: "toBeChecked()" },
  editable: { what: "editable state", on: "locator", call: "toBeEditable()" },
  text: { what: "text", on: "locator", call: "toHaveText(...)" },
  value: { what: "value", on: "locator", call: "toHaveValue(...)" },
  attribute: { what: "attribute", on: "locator", call: "toHaveAttribute(...)" },
  count: { what: "count", on: "locator", call: "toHaveCount(...)" },
};

interface MethodBody {
  returns: string;
  body: string;
  async: boolean;
}

/** Page object methods by name, read from the repository once per name. */
function methodIndex(context: CheckContext): (name: string) => MethodBody | undefined {
  const cache = new Map<string, MethodBody | undefined>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let result: MethodBody | undefined;
    const header = new RegExp(
      `^\\s*(?:(?:export|public|private|protected|static|override|readonly|async|function)\\s+)*${name.replace(/\$/g, "\\$")}\\s*\\([^)]*\\)\\s*(?::\\s*([^{]+?))?\\s*\\{\\s*$`,
    );
    for (const file of context.files()) {
      if (result !== undefined) break;
      if (!SOURCE_FILE.test(file)) continue;
      const text = context.read(file);
      if (text?.includes(name) !== true) continue;
      const parsed = parse(text);
      parsed.scan.masked.forEach((line, index) => {
        if (result !== undefined) return;
        const match = header.exec(line);
        if (match === null) return;
        const open = item(parsed.offsets, index, 0) + line.lastIndexOf("{");
        const close = closingParen(parsed.joined, open);
        if (close < 0) return;
        result = {
          returns: (match[1] ?? "").trim(),
          body: parsed.joined.slice(open, close),
          async: /\basync\b/.test(line),
        };
      });
    }
    cache.set(name, result);
    return result;
  };
}

/** The last call at the top level of an expression: its name and offset. */
function lastCall(masked: string): { name: string; at: number } | undefined {
  let depth = 0;
  let last: { name: string; at: number } | undefined;
  for (let at = 0; at < masked.length; at += 1) {
    const char = masked[at];
    if (char === "(" && depth === 0) {
      const name = /([#\w$]+)\s*$/.exec(masked.slice(0, at));
      if (name?.[1] !== undefined)
        last = { name: name[1].replace(/^#/, ""), at: at - name[0].length };
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
  }
  return last;
}

function readOf(
  masked: string,
  awaited: boolean,
  methods: (name: string) => MethodBody | undefined,
): { kind: ReadKind; at: number; name: string } | undefined {
  const call = lastCall(masked);
  if (call === undefined) return undefined;
  const direct = GETTERS[call.name];
  if (direct !== undefined) {
    return awaited || direct === "url" ? { kind: direct, at: call.at, name: call.name } : undefined;
  }
  const method = methods(call.name);
  if (method === undefined || /\bLocator\b/.test(method.returns)) return undefined;
  const inner = /\.\s*(\w+)\s*\(/g;
  for (const match of method.body.matchAll(inner)) {
    const kind = GETTERS[String(match[1])];
    if (kind === undefined) continue;
    if (!awaited && (kind !== "url" || method.async)) return undefined;
    return { kind, at: call.at, name: call.name };
  }
  return undefined;
}

function assertionCandidates(
  guideline: Guideline,
  file: string,
  parsed: Parsed,
  changed: ReadonlySet<number>,
  methods: (name: string) => MethodBody | undefined,
): Candidate[] {
  const { scan, joined, original, offsets } = parsed;
  const found: Candidate[] = [];
  for (const match of joined.matchAll(/(?<![\w$.])expect(?:\s*\.\s*soft)?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(joined, open);
    if (close < 0) continue;
    const subjectEnd = topLevelCommas(joined, open + 1, close)[0] ?? close;
    const tail = /^\s*(?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*(\w+)\s*\(/.exec(
      joined.slice(close + 1),
    );
    if (tail === null) continue;
    const matcherOpen = close + tail[0].length;
    const matcherClose = closingParen(joined, matcherOpen);
    const first = lineOf(offsets, match.index);
    const last = lineOf(offsets, matcherClose < 0 ? close : matcherClose);
    const touched = firstChanged(changed, first, last);
    if (touched === undefined) continue;
    const subject = joined.slice(open + 1, subjectEnd);
    const awaitedSubject = /^\s*await\s/.exec(subject);
    let read: { kind: ReadKind; at: number; name: string } | undefined;
    let base = open + 1;
    if (awaitedSubject !== null) {
      base += awaitedSubject[0].length;
      read = readOf(subject.slice(awaitedSubject[0].length), true, methods);
    } else {
      read = readOf(subject, false, methods);
    }
    if (read === undefined && matcherClose > 0) {
      const args = joined.slice(matcherOpen + 1, matcherClose);
      const awaited = /\bawait\s+/.exec(args);
      if (awaited !== null) {
        base = matcherOpen + 1 + awaited.index + awaited[0].length;
        const end = topLevelCommas(joined, base, matcherClose)[0] ?? matcherClose;
        read = readOf(joined.slice(base, end), true, methods);
      }
    }
    if (read === undefined) continue;
    const readLine = lineOf(offsets, base + read.at);
    const anchor = changed.has(readLine) ? readLine : touched;
    const quote = item(scan.lines, anchor - 1, "");
    const form = WEB_FIRST[read.kind];
    const readText = original.slice(base + read.at, base + read.at + read.name.length) + "()";
    const either =
      read.kind === "visible"
        ? `; when either of two elements may show, assert ${code("await expect(first.or(second)).toBeVisible()")}`
        : "";
    const matcher = form.call.slice(0, form.call.indexOf("("));
    const suggestion = oneLineRewrite(
      original,
      {
        keyword: match.index,
        close,
        subjectEnd,
        matcherOpen,
        matcherClose,
        matcher: String(tail[1]),
      },
      read.kind,
      quote,
      item(offsets, anchor - 1, 0),
    );
    found.push({
      guidelineId: guideline.id,
      check: "assertions",
      shape: "snapshot",
      file,
      line: anchor,
      quote,
      title: `${form.what.charAt(0).toUpperCase()}${form.what.slice(1)} read once inside an assertion`,
      body: `${code(readText)} reads the ${form.what} once, so the assertion checks a snapshot and cannot retry while the page settles. Assert web first instead: ${code(`await expect(${form.on}).${form.call}`)} retries until it holds${either}.`,
      form: matcher,
      ...(suggestion !== undefined ? { suggestion } : {}),
    });
  }
  return found;
}

interface Assertion {
  /** Offsets in the joined text: the expect keyword, its parens, the subject's end, the matcher's parens. */
  keyword: number;
  close: number;
  subjectEnd: number;
  matcherOpen: number;
  matcherClose: number;
  matcher: string;
}

/** The web-first form of a one line snapshot assertion the catalog can write exactly. */
function replacementOf(kind: ReadKind, matcher: string, expected: string): string | undefined {
  if (
    kind === "visible" &&
    (matcher === "toBeTruthy" || (matcher === "toBe" && expected === "true"))
  ) {
    return "toBeVisible()";
  }
  if (
    kind === "visible" &&
    (matcher === "toBeFalsy" || (matcher === "toBe" && expected === "false"))
  ) {
    return "toBeHidden()";
  }
  if (kind === "count" && (matcher === "toBe" || matcher === "toEqual"))
    return `toHaveCount(${expected})`;
  if (kind === "text" && (matcher === "toBe" || matcher === "toEqual"))
    return `toHaveText(${expected})`;
  if (kind === "text" && matcher === "toContain") return `toContainText(${expected})`;
  return undefined;
}

/** `expect(await x.isVisible()).toBe(true);` on one line becomes `await expect(x).toBeVisible();`. */
function oneLineRewrite(
  original: string,
  assertion: Assertion,
  kind: ReadKind,
  quote: string,
  start: number,
): string | undefined {
  const { keyword, close, subjectEnd, matcherOpen, matcherClose, matcher } = assertion;
  if (keyword < start || matcherClose < 0 || matcherClose >= start + quote.length) return undefined;
  const subject = original
    .slice(keyword, subjectEnd)
    .replace(/^expect\s*\(/, "")
    .trim();
  const got = /^await\s+([\s\S]+)\.\s*\w+\s*\(\s*\)$/.exec(subject);
  if (got === null || /\.\s*not\s*\./.test(original.slice(close, matcherOpen))) return undefined;
  const replacement = replacementOf(
    kind,
    matcher,
    original.slice(matcherOpen + 1, matcherClose).trim(),
  );
  if (replacement === undefined) return undefined;
  const before = quote.slice(0, keyword - start).replace(/await\s+$/, "");
  const message = original.slice(subjectEnd, close);
  return `${before}await expect(${String(got[1])}${message}).${replacement}${quote.slice(matcherClose - start + 1)}`;
}

// tags

function tagCandidates(
  guideline: Guideline,
  file: string,
  parsed: Parsed,
  changed: ReadonlySet<number>,
  declared: DeclaredTags | undefined,
): Candidate[] {
  const { scan, joined, original, offsets } = parsed;
  const found: Candidate[] = [];
  const allowed = new Set(declared === undefined ? [] : [...declared.features, ...declared.axis]);
  const call =
    /(?<![\w$.])test(?:\s*\.\s*(?:only|skip|fixme|fail|slow|describe)(?:\s*\.\s*(?:only|skip|fixme|serial|parallel))?)?\s*\(/g;
  for (const match of joined.matchAll(call)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(joined, open);
    if (close < 0) continue;
    const commas = topLevelCommas(joined, open + 1, close);
    const titleEnd = commas[0] ?? close;
    const title = original.slice(open + 1, titleEnd);
    const titleFrom = open + 1;
    for (const tag of title.matchAll(/(?:^|[\s'"`])(@[A-Za-z][\w:-]*)/g)) {
      const at = titleFrom + tag.index + tag[0].indexOf("@");
      const line = lineOf(offsets, at);
      if (!changed.has(line) || stringValue(title.trim()) === undefined) continue;
      found.push({
        guidelineId: guideline.id,
        check: "tags",
        shape: "title-tag",
        file,
        line,
        quote: item(scan.lines, line - 1, ""),
        title: "Tag in the test title",
        body: `${code(String(tag[1]))} sits in the test title; put it in the tag option instead, such as ${code(`{ tag: ['${String(tag[1])}'] }`)}.`,
      });
    }
    if (declared === undefined || commas[0] === undefined) continue;
    const optionEnd = commas[1] ?? close;
    const option = joined.slice(commas[0] + 1, optionEnd);
    const tagKey = /\btag\s*:\s*/.exec(option);
    if (!option.trim().startsWith("{") || tagKey === null) continue;
    const valueFrom = commas[0] + 1 + tagKey.index + tagKey[0].length;
    const arrayEnd = joined[valueFrom] === "[" ? closingParen(joined, valueFrom) : -1;
    const valueTo = arrayEnd > 0 ? arrayEnd + 1 : optionEnd;
    const valueText = original.slice(valueFrom, valueTo);
    for (const tag of valueText.matchAll(/(['"`])(@[^'"`]+)\1/g)) {
      const name = String(tag[2]);
      if (allowed.has(name)) continue;
      const at = valueFrom + tag.index;
      const line = lineOf(offsets, at);
      if (!changed.has(line)) continue;
      const quote = item(scan.lines, line - 1, "");
      const lineStart = item(offsets, line - 1, 0);
      let suggestion: string | undefined;
      if (
        arrayEnd > 0 &&
        lineOf(offsets, valueFrom) === line &&
        lineOf(offsets, arrayEnd) === line
      ) {
        const entries = valueText
          .slice(1, -1)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "" && stringValue(entry) !== name);
        if (entries.length > 0) {
          suggestion = `${quote.slice(0, valueFrom - lineStart)}[${entries.join(", ")}]${quote.slice(arrayEnd - lineStart + 1)}`;
        }
      }
      found.push({
        guidelineId: guideline.id,
        check: "tags",
        shape: "undeclared-tag",
        file,
        line,
        quote,
        title: "Tag the config does not declare",
        body: `${code(name)} is neither an axis tag nor a feature tag ${declared.source} declares, so the suite's check refuses it. Remove it, or use a declared tag that covers what the test checks.`,
        ...(suggestion !== undefined ? { suggestion } : {}),
      });
    }
  }
  return found;
}

/** The attribute getByTestId reads, from the repository config; data-testid when it names none. */
export function testIdAttributeOf(texts: readonly (string | undefined)[]): string {
  for (const text of texts) {
    const match = /\btestIdAttribute\s*:\s*['"]([^'"]+)['"]/.exec(text ?? "");
    if (match?.[1] !== undefined) return match[1];
  }
  return "data-testid";
}

/**
 * Every line the bound checks flag in the changed files, one per file, line
 * and guideline. A checked guideline yields findings only through these.
 */
export function findCandidates(
  bound: readonly BoundGuideline[],
  context: CheckContext,
): Candidate[] {
  const methods = methodIndex(context);
  const found: Candidate[] = [];
  const seen = new Set<string>();
  for (const [file, changed] of context.changed) {
    if (!SOURCE_FILE.test(file) || changed.size === 0) continue;
    const text = context.read(file);
    if (text === undefined) continue;
    const parsed = parse(text);
    for (const { guideline, check } of bound) {
      if (!appliesTo(guideline, [file])) continue;
      const candidates =
        check === "selectors"
          ? selectorCandidates(guideline, file, parsed, changed, context)
          : check === "comments"
            ? commentCandidates(guideline, file, parsed, changed)
            : check === "assertions"
              ? assertionCandidates(guideline, file, parsed, changed, methods)
              : tagCandidates(guideline, file, parsed, changed, context.declared);
      for (const candidate of candidates) {
        const key = `${candidate.file}:${String(candidate.line)}:${candidate.guidelineId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(candidate);
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
