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
    const header = /^diff --git a\/.* b\/(.+)$/m.exec(chunk);
    const filePath = header?.[1]?.replace(/^"|"$/g, "");
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

/** The b-side paths of every file chunk in a unified diff. */
export function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const match of diff.matchAll(/^diff --git a\/.* b\/(.+)$/gm)) {
    files.push(String(match[1]).replace(/^"|"$/g, ""));
  }
  return files;
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
    if (refExists(cwd, anchor) && isAncestorOfHead(cwd, anchor)) {
      mode = "incremental";
      notices.push(`incremental review of changes since ${anchor.slice(0, 12)}`);
      text = runGit(cwd, ["diff", "--no-color", `${anchor}..HEAD`, "--"]);
    } else {
      notices.push(
        `last reviewed commit ${anchor.slice(0, 12)} is not reachable from HEAD (rebase?); reviewing the full branch`,
      );
      text = mergeBaseDiff(cwd, ref);
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
