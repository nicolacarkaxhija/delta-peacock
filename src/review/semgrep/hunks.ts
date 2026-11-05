import { changedFilesFromDiff } from "../../git/diff.js";

/** A hunk the model does not receive. */
export interface Withheld {
  file: string;
  /** The hunk's header line. */
  hunk: string;
}

/** A whole hunk, its new side start captured. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)[\s\S]*$/;

const headerOf = (hunk: string): string => hunk.split("\n", 1).join("");

/** The new side line numbers a hunk adds or edits. */
function addedLines(hunk: string): number[] {
  let next = Number(hunk.replace(HUNK, "$1"));
  const added: number[] = [];
  for (const line of hunk.split("\n").slice(1)) {
    if (line.startsWith("+")) added.push(next);
    // context advances the new numbering, deletions and markers do not
    if (!line.startsWith("-") && !line.startsWith("\\")) next += 1;
  }
  return added;
}

/**
 * The diff without each hunk that holds a rule hit on an added line, in a
 * file no guideline left to the model covers; a file with no hunk left goes
 * whole, header included.
 */
export function withholdSettled(
  diff: string,
  settledLines: ReadonlyMap<string, ReadonlySet<number>>,
  settledFile: (file: string) => boolean,
): { diff: string; withheld: Withheld[] } {
  const withheld: Withheld[] = [];
  const kept = diff.split(/^(?=diff --git )/m).map((chunk) => {
    const file = changedFilesFromDiff(chunk)[0];
    const hits = file === undefined ? undefined : settledLines.get(file);
    if (file === undefined || hits === undefined || !settledFile(file)) return chunk;
    const hunks = chunk.split(/^(?=@@ )/m);
    const header = hunks.splice(0, 1).join("");
    const left = hunks.filter((hunk) => {
      if (!addedLines(hunk).some((line) => hits.has(line))) return true;
      withheld.push({ file, hunk: headerOf(hunk) });
      return false;
    });
    if (left.length === hunks.length) return chunk;
    return left.length === 0 ? "" : header + left.join("");
  });
  return { diff: kept.join(""), withheld };
}
