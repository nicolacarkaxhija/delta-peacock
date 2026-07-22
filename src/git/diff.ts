import picomatch from "picomatch";
import { ToolError } from "../errors.js";
import { runGit } from "./git.js";

/** Conservative ref shape: blocks option injection and git-level flag smuggling. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref)) {
    throw new ToolError(`unsafe git ref name: ${JSON.stringify(ref)}`);
  }
}

/**
 * The three-dot merge-base diff of HEAD against the target: exactly the
 * changes this branch introduces, excluding target-only commits (ADR 0004).
 */
export function mergeBaseDiff(cwd: string, target: string): string {
  assertSafeRef(target);
  return runGit(cwd, ["diff", "--no-color", `${target}...HEAD`, "--"]);
}

function refExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestorOfHead(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["merge-base", "--is-ancestor", ref, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** True when no target commit entered this branch after the anchor. */
function targetUnchangedSince(cwd: string, targetRef: string, anchor: string): boolean {
  try {
    const mergeBase = runGit(cwd, ["merge-base", targetRef, "HEAD"]).trim();
    runGit(cwd, ["merge-base", "--is-ancestor", mergeBase, anchor]);
    return true;
  } catch {
    return false;
  }
}

function hasOriginRemote(cwd: string): boolean {
  return runGit(cwd, ["remote"])
    .split("\n")
    .some((line) => line.trim() === "origin");
}

export interface ResolvedTarget {
  ref: string;
  notices: string[];
}

/** Prefer a freshly fetched origin/{target}; fall back to the local ref with a notice. */
export function resolveTargetRef(
  cwd: string,
  target: string,
  fetchTarget: boolean,
): ResolvedTarget {
  assertSafeRef(target);
  const notices: string[] = [];
  if (fetchTarget && hasOriginRemote(cwd)) {
    try {
      runGit(cwd, ["fetch", "--quiet", "origin", target]);
    } catch (error) {
      notices.push(
        `could not fetch origin/${target} (${String((error as Error).message.split("\n")[0])}); using local refs`,
      );
    }
    if (refExists(cwd, `origin/${target}`)) {
      return { ref: `origin/${target}`, notices };
    }
    notices.push(`origin/${target} not found; using local ${target}`);
  }
  return { ref: target, notices };
}

/** The b-side path of a chunk's `diff --git` header; handles git's quoted form. */
function headerPath(chunk: string): string | undefined {
  const header = /^diff --git (?:"a\/.*"|a\/.*) (?:"b\/(.+)"|b\/(.+))$/m.exec(chunk);
  if (!header) return undefined;
  return header[1] ?? header[2];
}

/** Keep only diff chunks whose path passes the include and exclude globs. */
export function filterDiffByPath(
  diff: string,
  include: readonly string[],
  exclude: readonly string[],
): string {
  if (diff === "" || (include.length === 0 && exclude.length === 0)) return diff;
  const isIncluded = include.length === 0 ? () => true : picomatch([...include]);
  const isExcluded = exclude.length === 0 ? () => false : picomatch([...exclude]);
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk !== "");
  const kept = chunks.filter((chunk) => {
    const filePath = headerPath(chunk);
    if (filePath === undefined) return true; // never silently drop what we cannot parse
    return isIncluded(filePath) && !isExcluded(filePath);
  });
  return kept.join("");
}

export interface DiffRequest {
  target: string;
  fetchTarget: boolean;
  lastReviewedCommit?: string;
  include: readonly string[];
  exclude: readonly string[];
  maxDiffBytes: number;
}

export interface AcquiredDiff {
  text: string;
  mode: "incremental" | "full";
  targetRef: string;
  notices: string[];
  /** Set when the review must not proceed; the text is empty then. */
  skipped?: "too-large";
}

/** The index against HEAD: what a pre-commit hook is about to commit. */
export function stagedDiff(
  cwd: string,
  request: Pick<DiffRequest, "include" | "exclude" | "maxDiffBytes">,
): AcquiredDiff {
  const raw = runGit(cwd, ["diff", "--cached"]);
  const text = filterDiffByPath(raw, request.include, request.exclude);
  if (Buffer.byteLength(text, "utf8") > request.maxDiffBytes) {
    return { text: "", mode: "full", targetRef: "the index", notices: [], skipped: "too-large" };
  }
  return { text, mode: "full", targetRef: "the index", notices: [] };
}

/** New-file line numbers to their text, per file: what the review anchored on. */
export function newLineTexts(diff: string): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const filePath = headerPath(chunk);
    if (filePath === undefined) continue;
    const lines = new Map<number, string>();
    let newLine = 0;
    for (const line of chunk.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (newLine === 0) continue; // still in the chunk header
      if (line.startsWith("+")) {
        lines.set(newLine, line.slice(1));
        newLine += 1;
      } else if (!line.startsWith("-") && !line.startsWith("\\")) {
        newLine += 1; // context advances the new numbering, deletions do not
      }
    }
    result.set(filePath, lines);
  }
  return result;
}

/** The b-side paths of every file chunk in a unified diff. */
export function changedFilesFromDiff(diff: string): string[] {
  return diff
    .split(/^(?=diff --git )/m)
    .map((chunk) => headerPath(chunk))
    .filter((filePath): filePath is string => filePath !== undefined);
}

export function acquireDiff(
  cwd: string,
  request: DiffRequest,
  preResolved?: ResolvedTarget,
): AcquiredDiff {
  const resolved = preResolved ?? resolveTargetRef(cwd, request.target, request.fetchTarget);
  const ref = resolved.ref;
  // when the caller resolved the target itself it already surfaced those notices
  const notices = preResolved ? [] : [...resolved.notices];

  let mode: "incremental" | "full" = "full";
  let text: string;
  const anchor = request.lastReviewedCommit;
  if (anchor !== undefined) {
    assertSafeRef(anchor);
    if (!refExists(cwd, anchor) || !isAncestorOfHead(cwd, anchor)) {
      notices.push(
        `last reviewed commit ${anchor.slice(0, 12)} is not reachable from HEAD (rebase?); reviewing the full branch`,
      );
      text = mergeBaseDiff(cwd, ref);
    } else if (!targetUnchangedSince(cwd, ref, anchor)) {
      // the branch pulled target commits in after the anchor; a plain
      // anchor..HEAD diff would review target-only changes (ADR 0004)
      notices.push(
        `the target moved into this branch since ${anchor.slice(0, 12)}; reviewing the full branch`,
      );
      text = mergeBaseDiff(cwd, ref);
    } else {
      mode = "incremental";
      notices.push(`incremental review of changes since ${anchor.slice(0, 12)}`);
      text = runGit(cwd, ["diff", "--no-color", `${anchor}..HEAD`, "--"]);
    }
  } else {
    text = mergeBaseDiff(cwd, ref);
  }

  text = filterDiffByPath(text, request.include, request.exclude);

  if (Buffer.byteLength(text, "utf8") > request.maxDiffBytes) {
    notices.push(
      `diff is ${String(Buffer.byteLength(text, "utf8"))} bytes, over the ${String(request.maxDiffBytes)} byte ceiling`,
    );
    return { text: "", mode, targetRef: ref, notices, skipped: "too-large" };
  }

  return { text, mode, targetRef: ref, notices };
}
