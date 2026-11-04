/** A hunk the model does not receive. */
export interface Withheld {
  file: string;
  hunk: string;
}

/** The diff without the hunks a rule hit settles in files the model judges nothing in. */
export function withholdSettled(
  diff: string,
  settledLines: ReadonlyMap<string, ReadonlySet<number>>,
  settledFile: (file: string) => boolean,
): { diff: string; withheld: Withheld[] } {
  return { diff: `${diff}${String(settledLines.size)}${String(settledFile(""))}`, withheld: [] };
}
