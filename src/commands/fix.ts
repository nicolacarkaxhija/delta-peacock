import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";
import {
  applyEdits,
  planFileEdits,
  renderPatch,
  suggestionsFrom,
  type SkipRecord,
  type Suggestion,
} from "../review/fix.js";
import type { ReviewReport } from "../review/report.js";

export interface FixOptions {
  report?: string;
  patchFile?: string;
  force: boolean;
}

function isDirty(cwd: string, file: string): boolean {
  try {
    return runGit(cwd, ["status", "--porcelain", "--", file]).trim() !== "";
  } catch {
    return true; // no git means no safety net; treat as dirty
  }
}

export function runFix(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: FixOptions,
): number {
  const config = deps.loadConfig(flags);
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
