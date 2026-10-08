import * as acorn from "acorn";
import picomatch from "picomatch";
import { AST_RULES, type AstCheck, type AstRule, type Guideline } from "../../domain/guideline.js";
import { quotesGuideline } from "../parse.js";
import { AST_RULE_SPECS, type Hit, type ParsedScript } from "./ast-rules.js";
import type { Candidate } from "./detect.js";
import { item } from "./source.js";

export type { ParsedScript } from "./ast-rules.js";

/** The files a syntax tree check reads: JavaScript, from Rhino era scripts to modules. */
export const SCRIPT_FILE = /\.(?:js|mjs|cjs)$/;

const KEYS = new Set(["type", "files", "rule", "message"]);

interface Compiled {
  covers: (file: string) => boolean;
  find: (script: ParsedScript) => Hit[];
}

/** Each declared check compiled once, keyed by the object the loader built. */
const compiledChecks = new WeakMap<AstCheck, Compiled>();

/** The loader's compiled form; a check built elsewhere compiles on first use and throws when invalid. */
function compile(check: AstCheck): Compiled {
  const known = compiledChecks.get(check);
  if (known !== undefined) return known;
  const find = AST_RULE_SPECS[check.rule].compile(check.params);
  if (typeof find === "string") throw new Error(`the ${check.rule} rule cannot run: ${find}`);
  const compiled: Compiled = {
    covers: check.files.length === 0 ? () => true : picomatch([...check.files]),
    find,
  };
  compiledChecks.set(check, compiled);
  return compiled;
}

/**
 * Reads a guideline's `check:` frontmatter of type ast into a compiled check,
 * or says why it cannot become one: its shape, an unknown rule, a parameter
 * the rule does not take or cannot read, or a message the guideline does not
 * say word for word.
 */
export function readAstCheck(
  record: Readonly<Record<string, unknown>>,
  guideline: Pick<Guideline, "id" | "title" | "body">,
): AstCheck | string {
  const where = `guideline "${guideline.id}" check`;
  const rule = record["rule"];
  if (typeof rule !== "string" || !AST_RULES.includes(rule as AstRule)) {
    return `${where}: "rule" must be one of ${AST_RULES.join(", ")}`;
  }
  const spec = AST_RULE_SPECS[rule as AstRule];
  const unknown = Object.keys(record).filter((key) => !KEYS.has(key) && !spec.keys.includes(key));
  if (unknown.length > 0) {
    return `${where}: unknown key(s) ${unknown.join(", ")} for the ${rule} rule`;
  }
  const files = record["files"];
  if (
    files !== undefined &&
    !(Array.isArray(files) && files.every((glob) => typeof glob === "string" && glob !== ""))
  ) {
    return `${where}: "files" must be a list of path globs`;
  }
  const message = record["message"];
  if (typeof message !== "string" || message === "") {
    return `${where}: "message" must be a non empty string`;
  }
  const params = Object.fromEntries(
    spec.keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]),
  );
  const problem = spec.compile(params);
  if (typeof problem === "string") return `${where}: ${problem}`;
  if (!quotesGuideline(message, guideline)) {
    return `${where}: "message" must be a sentence the guideline says word for word`;
  }
  const check: AstCheck = {
    type: "ast",
    files: (files as string[] | undefined) ?? [],
    rule: rule as AstRule,
    params,
    message,
  };
  compile(check);
  return check;
}

/** Whether a declared syntax tree check reads this file. */
export function astCovers(check: AstCheck, file: string): boolean {
  return SCRIPT_FILE.test(file) && compile(check).covers(file);
}

/** What acorn throws: the message ends with the line and column, `pos` is the offset. */
type ParseError = Error & { pos: number };

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (item(starts, middle, 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * Parses a script as the newest JavaScript, which covers ES5 era code too,
 * first as a script, then as a module. A file neither reads is the parser's
 * message, the furthest one of the two.
 */
export function parseScript(text: string): ParsedScript | string {
  const attempt = (sourceType: "script" | "module"): ParsedScript | ParseError => {
    const comments: acorn.Comment[] = [];
    try {
      const program = acorn.parse(text, {
        ecmaVersion: "latest",
        sourceType,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
        onComment: comments,
      });
      return { program, comments, text, lineAt: lineIndex(text) };
    } catch (error) {
      return error as ParseError;
    }
  };
  const asScript = attempt("script");
  if (!(asScript instanceof Error)) return asScript;
  const asModule = attempt("module");
  if (!(asModule instanceof Error)) return asModule;
  return (asModule.pos > asScript.pos ? asModule : asScript).message;
}

/** Findings a syntax tree check measures in one parsed file: every one a fact on a changed line. */
export function astCandidates(
  guideline: Guideline,
  check: AstCheck,
  file: string,
  script: ParsedScript,
  changed: ReadonlySet<number>,
): Candidate[] {
  const compiled = compile(check);
  const lines = script.text.split("\n").map((line) => line.replace(/\r$/, ""));
  const found: Candidate[] = [];
  const taken = new Set<number>();
  for (const hit of compiled.find(script)) {
    const line = hit.lines.find((one) => changed.has(one));
    if (line === undefined || taken.has(line)) continue;
    taken.add(line);
    found.push({
      guidelineId: guideline.id,
      check: "ast",
      shape: `ast-${check.rule}`,
      file,
      line,
      quote: item(lines, line - 1, ""),
      title: check.message.replace(/\.$/, ""),
      sentence: check.message,
      body: hit.body,
    });
  }
  return found.sort((a, b) => a.line - b.line);
}
