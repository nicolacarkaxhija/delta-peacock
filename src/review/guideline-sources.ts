import path from "node:path";
import { runGit } from "../git/git.js";
import type { ResolvedGuidelines } from "../guidelines/loader.js";
import type { GuidelineSource } from "../scm/publish.js";

const WORKING_TREE = "working tree";

/** The full hash a ref names; undefined when git cannot resolve it. */
function commitOf(cwd: string, ref: string): string | undefined {
  try {
    return runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Each local guideline's file in the repository and the commit it was read
 * from, so a link opens the text the review applied. A pack guideline, a
 * directory outside git or a commit git cannot name gets no entry.
 */
export function guidelineSources(
  cwd: string,
  loaded: Pick<ResolvedGuidelines, "guidelines" | "origin">,
  reviewedCommit: string | undefined,
): Map<string, GuidelineSource> {
  const sources = new Map<string, GuidelineSource>();
  const fromTree = loaded.origin === WORKING_TREE;
  if (loaded.origin.startsWith("local:")) return sources;
  const commit = fromTree ? reviewedCommit : commitOf(cwd, loaded.origin);
  if (commit === undefined) return sources;
  const prefix = `${loaded.origin}:`;
  for (const guideline of loaded.guidelines) {
    if (guideline.pack !== undefined) continue;
    const file = fromTree
      ? path.relative(cwd, guideline.sourcePath).replaceAll("\\", "/")
      : guideline.sourcePath.startsWith(prefix)
        ? guideline.sourcePath.slice(prefix.length)
        : undefined;
    if (file === undefined || file.startsWith("../")) continue;
    sources.set(guideline.id, { path: file, commit });
  }
  return sources;
}
