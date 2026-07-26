import type { ReportedFinding, ReviewReport } from "./report.js";

export interface Suggestion {
  file: string;
  line: number;
  lineText: string | undefined;
  replacement: string;
  title: string;
}

export interface SkipRecord {
  file: string;
  line: number;
  reason: string;
}

export interface FileEdit {
  line: number;
  oldText: string;
  newLines: string[];
}

/** The report's findings that carry a concrete replacement, as suggestions. */
export function suggestionsFrom(report: ReviewReport): Suggestion[] {
  return report.findings
    .filter(
      (finding): finding is ReportedFinding & { suggestion: string } =>
        typeof finding.suggestion === "string",
    )
    .map((finding) => ({
      file: finding.file,
      line: finding.line,
      lineText: finding.lineText,
      replacement: finding.suggestion.replace(/\r?\n$/, ""),
      title: finding.title,
    }));
}

/** One file's edits, validated against its current content, applied bottom-up. */
export function planFileEdits(
  lines: readonly string[],
  wanted: readonly Suggestion[],
): { edits: FileEdit[]; skipped: SkipRecord[] } {
  const edits: FileEdit[] = [];
  const skipped: SkipRecord[] = [];
  const taken = new Set<number>();
  for (const suggestion of wanted) {
    const { file, line } = suggestion;
    const current = lines[line - 1];
    if (current === undefined) {
      skipped.push({ file, line, reason: "the file no longer has that line" });
    } else if (suggestion.lineText === undefined) {
      skipped.push({ file, line, reason: "the report carries no anchor text for it" });
    } else if (current !== suggestion.lineText) {
      skipped.push({ file, line, reason: "the line changed since the review" });
    } else if (taken.has(line)) {
      skipped.push({ file, line, reason: "another suggestion already edits that line" });
    } else {
      taken.add(line);
      edits.push({ line, oldText: current, newLines: suggestion.replacement.split("\n") });
    }
  }
  return { edits: edits.sort((a, b) => a.line - b.line), skipped };
}

export function applyEdits(lines: readonly string[], edits: readonly FileEdit[]): string[] {
  const result = [...lines];
  // bottom-up, so earlier line numbers stay valid
  for (const edit of [...edits].sort((a, b) => b.line - a.line)) {
    result.splice(edit.line - 1, 1, ...edit.newLines);
  }
  return result;
}

/** A git-apply-ready unified diff with one line of context around each hunk. */
export function renderPatch(
  file: string,
  lines: readonly string[],
  edits: readonly FileEdit[],
): string {
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let offset = 0;
  let lastOldEnd = 0;
  for (const edit of edits) {
    // context must never overlap the previous hunk's range
    const pre = edit.line - 1 > lastOldEnd ? lines[edit.line - 2] : undefined;
    const post = edit.line < lines.length ? lines[edit.line] : undefined;
    const oldCount = 1 + (pre !== undefined ? 1 : 0) + (post !== undefined ? 1 : 0);
    const newCount =
      edit.newLines.length + (pre !== undefined ? 1 : 0) + (post !== undefined ? 1 : 0);
    const oldStart = pre !== undefined ? edit.line - 1 : edit.line;
    const newStart = oldStart + offset;
    out.push(
      `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@`,
    );
    if (pre !== undefined) out.push(` ${pre}`);
    out.push(`-${edit.oldText}`);
    for (const added of edit.newLines) out.push(`+${added}`);
    if (post !== undefined) out.push(` ${post}`);
    offset += edit.newLines.length - 1;
    lastOldEnd = oldStart + oldCount - 1;
  }
  return `${out.join("\n")}\n`;
}
