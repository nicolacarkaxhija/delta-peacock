import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import type { Finding } from "../domain/finding.js";
import type { Guideline } from "../domain/guideline.js";
import type { DeclaredTags } from "./declared.js";
import { matchesGoodExample } from "./examples.js";
import type { RejectedCandidate } from "./parse.js";

/** The file's lines at the reviewed commit; undefined when it cannot be read. */
export type LinesOf = (file: string) => readonly string[] | undefined;

/** The lines a diff shows of a file, blanks where it shows none. */
export function linesFromDiff(known: ReadonlyMap<number, string>): string[] {
  const last = Math.max(0, ...known.keys());
  return Array.from({ length: last }, (_, index) => known.get(index + 1) ?? "");
}

function firstLine(quote: string): string {
  return (
    quote
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function withoutSuggestion<T extends Finding>(finding: T, note: string): T {
  const copy: T = { ...finding, note };
  delete copy.suggestion;
  return copy;
}

function unplaced<T extends Finding>(finding: T, note: string): T {
  return { ...withoutSuggestion(finding, note), unplaced: true };
}

/**
 * Puts each finding on the line it quotes. The model counts line numbers by
 * hand and drifts; the quote is what it actually saw. A quote on the named
 * line stays; a quote found on exactly one other line moves there; anything
 * else sits on no line, loses its suggestion and says why, so no comment ever
 * lands on a line it does not mean and no suggestion replaces a line it did
 * not quote.
 */
export function placeFindings(findings: readonly Finding[], linesOf: LinesOf): Finding[] {
  return findings.map((finding) => {
    const quote = finding.quote === undefined ? "" : firstLine(finding.quote);
    if (quote === "") {
      return unplaced(
        finding,
        "The review did not quote the line it means, so this finding is not placed on a line.",
      );
    }
    const lines = linesOf(finding.file);
    if (lines === undefined) {
      return unplaced(
        finding,
        `\`${finding.file}\` could not be read at the reviewed commit, so this finding is not placed on a line.`,
      );
    }
    const matches: number[] = [];
    lines.forEach((text, index) => {
      if (text.trim() === quote) matches.push(index + 1);
    });
    const line = matches.includes(finding.line)
      ? finding.line
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (line === undefined) {
      const why = matches.length === 0 ? "is not in" : "appears more than once in";
      return unplaced(
        finding,
        `The quoted line \`${quote}\` ${why} \`${finding.file}\`, so this finding is not placed on a line.`,
      );
    }
    const placed = { ...finding, line };
    if (placed.suggestion !== undefined && finding.quote?.trim().includes("\n") === true) {
      return withoutSuggestion(
        placed,
        "The suggested change was left out because it covers more than the one quoted line.",
      );
    }
    return placed;
  });
}

/** A tag in a tag list or a title: `@` after a quote, a bracket, a comma or a space. */
const TAG_IN_STRING = /(?:^|[\s'"`[(,])(@[A-Za-z][\w:-]*)(?![\w:/-])/g;
const IMPORT_FROM = /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/g;

function packageNames(cwd: string): Set<string> | undefined {
  const manifest = path.join(cwd, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const block = parsed[field];
      if (typeof block === "object" && block !== null) {
        for (const name of Object.keys(block)) names.add(name);
      }
    }
    if (typeof parsed["name"] === "string") names.add(parsed["name"]);
    return names;
  } catch {
    return undefined;
  }
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/** A relative import resolves when a file with that stem exists; `.js` may stand for `.ts`. */
function relativeExists(cwd: string, fromFile: string, specifier: string): boolean {
  const base = path.resolve(cwd, path.dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"].map((ext) => `${stem}${ext}`),
    ...["index.ts", "index.js"].map((name) => path.join(base, name)),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

export interface SuggestionContext {
  cwd: string;
  tags?: DeclaredTags;
}

/**
 * A suggestion may not bring in a tag or an import the repository does not
 * declare; one that does is left out with a note, the finding itself stays.
 */
export function vetSuggestions(
  findings: readonly Finding[],
  context: SuggestionContext,
): Finding[] {
  const { tags } = context;
  const declared = new Set(tags === undefined ? [] : [...tags.features, ...tags.axis]);
  const packages = packageNames(context.cwd);
  return findings.map((finding) => {
    if (finding.suggestion === undefined) return finding;
    const original = finding.quote ?? "";
    for (const match of tags === undefined ? [] : finding.suggestion.matchAll(TAG_IN_STRING)) {
      const tag = String(match[1]);
      if (!declared.has(tag) && !original.includes(tag)) {
        return withoutSuggestion(
          finding,
          `The suggested change was left out because \`${tag}\` is not a tag ${String(tags?.source)} declares.`,
        );
      }
    }
    for (const match of finding.suggestion.matchAll(IMPORT_FROM)) {
      const specifier = String(match[1]);
      if (original.includes(specifier)) continue;
      const known = specifier.startsWith(".")
        ? relativeExists(context.cwd, finding.file, specifier)
        : specifier.startsWith("node:") ||
          builtinModules.includes(specifier) ||
          packages === undefined ||
          packages.has(packageOf(specifier));
      if (known) continue;
      return withoutSuggestion(
        finding,
        `The suggested change was left out because it imports \`${specifier}\`, which the repository does not have.`,
      );
    }
    return finding;
  });
}

/** Lines above a finding searched for the comment its suggestion would add. */
const COMMENT_REACH = 10;

/** The text of a line comment or a one line block comment, without its markers. */
function commentText(line: string): string | undefined {
  const match = /(?:\/\/+|\/\*+)\s*(.*?)\s*(?:\*\/)?\s*$/.exec(line);
  const text = match?.[1]?.trim();
  return text === undefined || text === "" ? undefined : text.toLowerCase();
}

/**
 * The comment a suggestion adds: the quoted code with a comment on it, or a
 * comment line before it. Undefined when the suggestion changes the code.
 */
function addedComment(quote: string, suggestion: string): string | undefined {
  const code = quote.trim();
  const lines = suggestion
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  if (lines.length === 2 && last === code) return commentText(lines[0] ?? "");
  if (lines.length === 1 && last.startsWith(code) && last !== code) {
    return commentText(last.slice(code.length));
  }
  return undefined;
}

/**
 * Drops a finding whose only fix is a comment the file already carries just
 * above the flagged line: a reason in reach is the reason the rule asks for,
 * and moving it is not a fix. Deterministic, like the Good example gate.
 */
export function dropCommentMoves(
  findings: readonly Finding[],
  linesOf: LinesOf,
): { kept: Finding[]; dropped: RejectedCandidate[] } {
  const kept: Finding[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const finding of findings) {
    const comment =
      finding.suggestion !== undefined && finding.quote !== undefined
        ? addedComment(finding.quote, finding.suggestion)
        : undefined;
    const above =
      comment === undefined
        ? []
        : (linesOf(finding.file) ?? []).slice(
            Math.max(0, finding.line - 1 - COMMENT_REACH),
            finding.line - 1,
          );
    const present =
      comment !== undefined && above.some((line) => commentText(line)?.includes(comment) === true);
    if (present) {
      dropped.push({
        reason: "comment-move",
        raw: JSON.stringify({
          file: finding.file,
          line: finding.line,
          suggestion: finding.suggestion,
        }),
        ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
        title: finding.title,
      });
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}

/**
 * Drops a finding whose quoted code is shown as right by its own guideline's
 * Good example; the rule cannot be broken by code it holds up as the model.
 */
export function dropGoodExamples(
  findings: readonly Finding[],
  guidelinesById: ReadonlyMap<string, Guideline>,
): { kept: Finding[]; dropped: RejectedCandidate[] } {
  const kept: Finding[] = [];
  const dropped: RejectedCandidate[] = [];
  for (const finding of findings) {
    const guideline =
      finding.kind === "violation" ? guidelinesById.get(finding.guidelineId) : undefined;
    if (
      guideline !== undefined &&
      finding.quote !== undefined &&
      matchesGoodExample(finding.quote, guideline)
    ) {
      dropped.push({
        reason: "good-example",
        raw: JSON.stringify({ file: finding.file, line: finding.line, quote: finding.quote }),
        guidelineId: guideline.id,
        title: finding.title,
      });
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}
