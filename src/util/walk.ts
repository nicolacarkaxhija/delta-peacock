import { readdirSync } from "node:fs";
import path from "node:path";

/** The directory names every repo walker in the project has skipped. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "vendor",
  "build",
]);

export interface WalkOptions {
  /** Directory names to skip outright; dotdirs (`.foo`) are always skipped too. */
  skipDirs: ReadonlySet<string>;
  /** Stops once this many files have been collected; unset means unlimited. */
  maxFiles?: number;
  /** A cheap, dirent-only test; only files it accepts are collected. Defaults to every file. */
  include?: (entry: { name: string; fullPath: string }) => boolean;
  /**
   * What to do when a directory cannot be listed (permissions, a broken
   * symlink). "skip" treats it as empty, the posture most callers want;
   * "throw" lets the error surface, for a caller that must not swallow it.
   */
  onReaddirError?: "skip" | "throw";
}

/**
 * Every file under root, depth-first, honoring a skip-dir set (plus dotdirs,
 * always) and an optional file-count ceiling and cheap per-entry filter.
 * This owns only the traversal every repo walker in the project repeated;
 * size caps, binary checks and include/exclude globs stay with each caller
 * since they need to read file content the walk itself never touches.
 */
export function walkFiles(root: string, options: WalkOptions): string[] {
  const { skipDirs, maxFiles, include, onReaddirError = "skip" } = options;
  const files: string[] = [];
  const visit = (dir: string): void => {
    if (maxFiles !== undefined && files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (onReaddirError === "throw") throw error;
      return;
    }
    for (const entry of entries) {
      if (maxFiles !== undefined && files.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) visit(full);
        continue;
      }
      /* v8 ignore next -- sockets and fifos are not portably simulable */
      if (!entry.isFile()) continue;
      if (include === undefined || include({ name: entry.name, fullPath: full })) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}
