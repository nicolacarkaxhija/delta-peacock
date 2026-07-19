import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";
import type { ReportedFinding, ReviewReport } from "../review/report.js";

export interface FixOptions {
  report?: string;
  patchFile?: string;
  force: boolean;
}

interface Suggestion {
  file: string;
  line: number;
  lineText: string | undefined;
  replacement: string;
  title: string;
}

interface SkipRecord {
  file: string;
  line: number;
  reason: string;
}

interface FileEdit {
  line: number;
  oldText: string;
  newLines: string[];
}

function suggestionsFrom(report: ReviewReport): Suggestion[] {
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

function isDirty(cwd: string, file: string): boolean {
  try {
    return runGit(cwd, ["status", "--porcelain", "--", file]).trim() !== "";
  } catch {
    return true; // no git means no safety net; treat as dirty
  }
}

/** One file's edits, validated against its current content, applied bottom-up. */
function planFileEdits(
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

function applyEdits(lines: readonly string[], edits: readonly FileEdit[]): string[] {
  const result = [...lines];
  // bottom-up, so earlier line numbers stay valid
  for (const edit of [...edits].sort((a, b) => b.line - a.line)) {
    result.splice(edit.line - 1, 1, ...edit.newLines);
  }
  return result;
}

/** A git-apply-ready unified diff with one line of context around each hunk. */
function renderPatch(file: string, lines: readonly string[], edits: readonly FileEdit[]): string {
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

export function runFix(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: FixOptions,
): number {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });
  const reportRel = options.report ?? config.output.report;
  if (reportRel === undefined) {
    throw new ToolError("fix needs a report: pass --report or configure output.report");
  }
  const reportPath = path.resolve(deps.cwd, reportRel);
  if (!existsSync(reportPath)) {
    throw new ToolError(`no report at ${reportPath}; run a review with --report first`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReviewReport;
  const suggestions = suggestionsFrom(report);
  if (suggestions.length === 0) {
    deps.out("nothing to fix: the report holds no suggestions\n");
    return 0;
  }

  const byFile = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions) {
    const list = byFile.get(suggestion.file) ?? [];
    list.push(suggestion);
    byFile.set(suggestion.file, list);
  }

  let applied = 0;
  const skipped: SkipRecord[] = [];
  const patches: string[] = [];
  for (const [file, wanted] of byFile) {
    const full = path.join(deps.cwd, file);
    if (!existsSync(full)) {
      skipped.push(...wanted.map(({ line }) => ({ file, line, reason: "the file is gone" })));
      continue;
    }
    if (options.patchFile === undefined && !options.force && isDirty(deps.cwd, file)) {
      skipped.push(
        ...wanted.map(({ line }) => ({
          file,
          line,
          reason: "the file has uncommitted changes; pass --force to edit it anyway",
        })),
      );
      continue;
    }
    const raw = readFileSync(full, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const split = raw.split(/\r?\n/);
    const hadTrailingNewline = split.at(-1) === "";
    const lines = hadTrailingNewline ? split.slice(0, -1) : split;
    const plan = planFileEdits(lines, wanted);
    skipped.push(...plan.skipped);
    if (plan.edits.length === 0) continue;
    applied += plan.edits.length;
    if (options.patchFile !== undefined) {
      patches.push(renderPatch(file, lines, plan.edits));
    } else {
      const edited = applyEdits(lines, plan.edits).join(eol);
      writeFileSync(full, hadTrailingNewline ? `${edited}${eol}` : edited);
      for (const edit of plan.edits) {
        deps.out(`applied  ${file}:${String(edit.line)}\n`);
      }
    }
  }

  if (options.patchFile !== undefined && patches.length > 0) {
    writeFileSync(path.resolve(deps.cwd, options.patchFile), patches.join(""));
    deps.out(`patch with ${String(applied)} edit(s) written to ${options.patchFile}\n`);
  }
  for (const skip of skipped) {
    deps.out(`skipped  ${skip.file}:${String(skip.line)}  ${skip.reason}\n`);
  }
  deps.out(`${String(applied)} applied, ${String(skipped.length)} skipped\n`);
  return skipped.length > 0 ? 3 : 0;
}
