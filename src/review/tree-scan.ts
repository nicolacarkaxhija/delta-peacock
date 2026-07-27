import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { DEFAULT_SKIP_DIRS, walkFiles } from "../util/walk.js";

const SKIP_DIRS = new Set([...DEFAULT_SKIP_DIRS, ".delta-peacock-cache"]);
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Every reviewable text file under the tree, relative and forward-slashed,
 * honoring the include/exclude globs and skipping vendored trees, oversized
 * files and binaries. The whole-tree counterpart to a diff for the audit.
 */
export function collectFiles(
  cwd: string,
  include: readonly string[],
  exclude: readonly string[],
): string[] {
  const isIncluded = include.length === 0 ? () => true : picomatch([...include]);
  const isExcluded = exclude.length === 0 ? () => false : picomatch([...exclude]);
  const files: string[] = [];
  for (const full of walkFiles(cwd, { skipDirs: SKIP_DIRS, onReaddirError: "throw" })) {
    const relative = path.relative(cwd, full).replaceAll("\\", "/");
    if (!isIncluded(relative) || isExcluded(relative)) continue;
    if (statSync(full).size > MAX_FILE_BYTES) continue;
    const content = readFileSync(full, "utf8");
    if (content.includes("\u0000")) continue; // binary
    files.push(relative);
  }
  return files.sort();
}

/** A whole file rendered as a new-file diff, so the review machinery applies. */
export function fileAsDiff(relative: string, content: string): string {
  const body = content.replace(/\n$/, "");
  const lines = body === "" ? [] : body.split("\n");
  return [
    `diff --git a/${relative} b/${relative}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relative}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export interface Batch {
  files: string[];
  diff: string;
}

/** Packs whole-file diffs up to a byte ceiling; never splits a single file. */
export function batchFiles(
  cwd: string,
  files: readonly string[],
  maxBytes: number,
  notices: string[],
): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { files: [], diff: "" };
  for (const relative of files) {
    const chunk = fileAsDiff(relative, readFileSync(path.join(cwd, relative), "utf8"));
    const size = Buffer.byteLength(chunk, "utf8");
    if (size > maxBytes) {
      notices.push(`${relative} alone exceeds the size ceiling; skipped`);
      continue;
    }
    if (current.files.length > 0 && Buffer.byteLength(current.diff, "utf8") + size > maxBytes) {
      batches.push(current);
      current = { files: [], diff: "" };
    }
    current.files.push(relative);
    current.diff += chunk;
  }
  if (current.files.length > 0) batches.push(current);
  return batches;
}
