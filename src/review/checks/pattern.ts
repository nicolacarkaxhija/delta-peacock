import picomatch from "picomatch";
import type { Guideline, PatternCheck } from "../../domain/guideline.js";
import { quotesGuideline } from "../parse.js";
import type { Candidate } from "./detect.js";
import { item } from "./source.js";

interface Compiled {
  covers: (file: string) => boolean;
  added?: RegExp;
  unless?: RegExp;
  absent?: RegExp;
}

const KEYS = new Set([
  "type",
  "files",
  "added",
  "unless",
  "absent",
  "scope",
  "maxPerFile",
  "message",
]);

/** Each declared check compiled once, keyed by the object the loader built. */
const compiledChecks = new WeakMap<PatternCheck, Compiled>();

const coverOf = (files: readonly string[]): ((file: string) => boolean) =>
  files.length === 0 ? () => true : picomatch([...files]);

/** The loader's compiled form; a check built elsewhere compiles on first use. */
function compile(check: PatternCheck): Compiled {
  const known = compiledChecks.get(check);
  if (known !== undefined) return known;
  const compiled: Compiled = {
    covers: coverOf(check.files),
    ...(check.added !== undefined ? { added: new RegExp(check.added) } : {}),
    ...(check.unless !== undefined ? { unless: new RegExp(check.unless) } : {}),
    ...(check.absent !== undefined ? { absent: new RegExp(check.absent) } : {}),
  };
  compiledChecks.set(check, compiled);
  return compiled;
}

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === "string" && value !== "");

/** Why the `check:` frontmatter cannot drive a review, or undefined when it can. */
function shapeProblem(raw: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(raw).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) return `unknown key(s) ${unknown.join(", ")}`;
  if (raw["type"] !== "pattern") return `"type" must be pattern`;
  const files = raw["files"];
  if (
    files !== undefined &&
    !(Array.isArray(files) && files.every((glob) => typeof glob === "string" && glob !== ""))
  ) {
    return `"files" must be a list of path globs`;
  }
  for (const key of ["added", "unless", "absent", "message"]) {
    if (!optionalString(raw[key])) return `"${key}" must be a non empty string`;
  }
  if ((raw["added"] === undefined) === (raw["absent"] === undefined)) {
    return `exactly one of "added" and "absent" is needed`;
  }
  const scope = raw["scope"] ?? (raw["absent"] !== undefined ? "file" : "line");
  if (raw["added"] !== undefined && scope !== "line") return `"added" reads lines: scope line`;
  if (raw["absent"] !== undefined && scope !== "file") return `"absent" reads files: scope file`;
  if (raw["absent"] !== undefined && raw["unless"] !== undefined) {
    return `"unless" excuses an "added" match only`;
  }
  const cap = raw["maxPerFile"];
  if (cap !== undefined && !(typeof cap === "number" && Number.isInteger(cap) && cap > 0)) {
    return `"maxPerFile" must be a positive whole number`;
  }
  if (raw["message"] === undefined) return `"message" is needed`;
  return undefined;
}

/**
 * Reads a guideline's `check:` frontmatter into a compiled pattern check, or
 * says why it cannot become one: its shape, an invalid regex, or a message
 * the guideline does not say word for word.
 */
export function readPatternCheck(
  raw: unknown,
  guideline: Pick<Guideline, "id" | "title" | "body">,
): PatternCheck | string {
  const where = `guideline "${guideline.id}" check`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${where} must be a mapping`;
  }
  const record = raw as Record<string, unknown>;
  const problem = shapeProblem(record);
  if (problem !== undefined) return `${where}: ${problem}`;
  const cap = record["maxPerFile"] as number | undefined;
  const check: PatternCheck = {
    type: "pattern",
    files: (record["files"] as string[] | undefined) ?? [],
    message: record["message"] as string,
    ...(cap !== undefined ? { maxPerFile: cap } : {}),
  };
  const compiled: Compiled = { covers: coverOf(check.files) };
  for (const key of ["added", "unless", "absent"] as const) {
    const source = record[key] as string | undefined;
    if (source === undefined) continue;
    try {
      compiled[key] = new RegExp(source);
    } catch (error) {
      return `${where}: "${key}" is not a valid regex: ${(error as Error).message}`;
    }
    check[key] = source;
  }
  if (!quotesGuideline(check.message, guideline)) {
    return `${where}: "message" must be a sentence the guideline says word for word`;
  }
  compiledChecks.set(check, compiled);
  return check;
}

const code = (text: string): string => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``);

/** Findings a pattern check measures in one changed file: every one a fact. */
export function patternCandidates(
  guideline: Guideline,
  file: string,
  text: string,
  changed: ReadonlySet<number>,
): Candidate[] {
  const check = guideline.check;
  if (check === undefined || changed.size === 0) return [];
  const compiled = compile(check);
  if (!compiled.covers(file)) return [];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const added = [...changed].sort((a, b) => a - b);
  const base = {
    guidelineId: guideline.id,
    check: "pattern" as const,
    file,
    title: check.message.replace(/\.$/, ""),
    sentence: check.message,
  };
  if (compiled.absent !== undefined) {
    if (compiled.absent.test(text)) return [];
    const line = added[0] ?? 1;
    return [
      {
        ...base,
        shape: "pattern-absent",
        line,
        quote: item(lines, line - 1, ""),
        body: `This file holds nothing that matches ${code(check.absent ?? "")}, which the guideline asks of every file it covers.`,
      },
    ];
  }
  const found: Candidate[] = [];
  for (const line of added) {
    const source = item(lines, line - 1, "");
    const match = compiled.added?.exec(source);
    if (match === null || match === undefined) continue;
    if (compiled.unless?.test(source) === true) continue;
    found.push({
      ...base,
      shape: "pattern-added",
      line,
      quote: source,
      body: `The added line holds ${code(match[0])}, which the guideline forbids.`,
    });
  }
  const cap = check.maxPerFile;
  if (cap === undefined || found.length <= cap) return found;
  const kept = found.slice(0, cap);
  const last = kept[cap - 1];
  if (last !== undefined) {
    last.body = `${last.body} ${String(found.length - cap)} more added line(s) in this file match as well.`;
  }
  return kept;
}
