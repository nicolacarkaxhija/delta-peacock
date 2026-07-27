import picomatch from "picomatch";
import { ToolError } from "../errors.js";
import { runGit } from "./git.js";

/**
 * Local git could not produce a diff because the target is unreachable here
 * (a shallow or absent clone). ADR 0004 scopes the SCM-API fallback to
 * exactly this; a caller must not treat any other failure (a malformed ref,
 * say) the same way.
 */
export class LocalDiffUnavailableError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = "LocalDiffUnavailableError";
  }
}

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

function listRemotes(cwd: string): string[] {
  return runGit(cwd, ["remote"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The branch HEAD is on, or undefined for a detached HEAD. */
function currentBranch(cwd: string): string | undefined {
  try {
    const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** The remote this branch tracks, or undefined when no upstream is configured. */
function trackedRemote(cwd: string, branch: string): string | undefined {
  try {
    const remote = runGit(cwd, [
      "for-each-ref",
      "--format=%(upstream:remotename)",
      `refs/heads/${branch}`,
    ]).trim();
    return remote === "" ? undefined : remote;
  } catch {
    return undefined;
  }
}

interface RemoteResolution {
  /** The remote to fetch from; undefined means none could be chosen. */
  remote?: string;
  /** True when remotes exist but none could be chosen unambiguously. */
  ambiguous: boolean;
  remotes: string[];
}

/**
 * The remote ADR 0004's fetch should use: the current branch's own upstream
 * first (correct even when it isn't named "origin"), else the sole remote.
 * Zero remotes is a plain standalone repo, not worth a warning; two or more
 * with no tracked upstream is genuinely ambiguous and is reported as such.
 */
function resolveFetchRemote(cwd: string): RemoteResolution {
  const remotes = listRemotes(cwd);
  const branch = currentBranch(cwd);
  const tracked = branch !== undefined ? trackedRemote(cwd, branch) : undefined;
  if (tracked !== undefined) return { remote: tracked, ambiguous: false, remotes };
  const sole = remotes.length === 1 ? remotes[0] : undefined;
  if (sole !== undefined) return { remote: sole, ambiguous: false, remotes };
  return { ambiguous: remotes.length > 1, remotes };
}

export interface ResolvedTarget {
  ref: string;
  notices: string[];
}

/**
 * True when `target` already names a remote-tracking ref rather than a bare
 * branch name: either syntactically, by starting with a configured remote's
 * name, or because that exact ref already resolves under refs/remotes/ (a
 * tracking ref left behind by a remote since renamed or removed). A bare
 * name never matches here even if a like-named local branch exists — that
 * must still go through the fetch-and-qualify path below so it resolves to
 * the remote-tracking ref, not the local one.
 */
function isRemoteQualified(cwd: string, target: string, remotes: readonly string[]): boolean {
  if (remotes.some((remote) => target === remote || target.startsWith(`${remote}/`))) return true;
  return refExists(cwd, `refs/remotes/${target}`);
}

/** Prefer a freshly fetched {remote}/{target}; fall back to the local ref with a notice. */
export function resolveTargetRef(
  cwd: string,
  target: string,
  fetchTarget: boolean,
): ResolvedTarget {
  assertSafeRef(target);
  const notices: string[] = [];
  if (fetchTarget) {
    const resolution = resolveFetchRemote(cwd);
    // already a remote-tracking ref: use it as given rather than prepending
    // a remote name it may already carry (that produced origin/origin/...)
    if (isRemoteQualified(cwd, target, resolution.remotes)) {
      return { ref: target, notices };
    }
    if (resolution.remote !== undefined) {
      const remote = resolution.remote;
      try {
        runGit(cwd, ["fetch", "--quiet", remote, target]);
      } catch (error) {
        notices.push(
          `could not fetch ${remote}/${target} (${String((error as Error).message.split("\n")[0])}); using local refs`,
        );
      }
      if (refExists(cwd, `${remote}/${target}`)) {
        return { ref: `${remote}/${target}`, notices };
      }
      notices.push(`${remote}/${target} not found; using local ${target}`);
    } else if (resolution.ambiguous) {
      notices.push(
        `no single usable remote (${resolution.remotes.join(", ")}) and this branch tracks none of them; skipping the ADR-required fetch and using local ${target}`,
      );
    }
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

/** Added lines in a unified diff: the denominator contributor stats normalize by. */
export function addedLineCount(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) count += 1;
  }
  return count;
}

/** The author handle recorded for a commit; empty when git cannot say. */
export function commitAuthor(cwd: string, ref: string): string {
  try {
    return runGit(cwd, ["log", "-1", "--format=%an", ref]).trim();
  } catch {
    return "";
  }
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

  // validated up front, outside the git-failure boundary below: a malformed
  // anchor is a configuration mistake, never a shallow-clone symptom
  const anchor = request.lastReviewedCommit;
  if (anchor !== undefined) assertSafeRef(anchor);

  let mode: "incremental" | "full" = "full";
  let text: string;
  try {
    if (anchor !== undefined) {
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
  } catch (error) {
    // the only git failure possible here, past the validation above, is the
    // target being unreachable in this clone (shallow or absent) — ADR
    // 0004's fallback condition, so it is the only one wrapped for a caller
    // to recognize and reroute to the SCM API diff
    throw new LocalDiffUnavailableError(error instanceof Error ? error.message : String(error));
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
