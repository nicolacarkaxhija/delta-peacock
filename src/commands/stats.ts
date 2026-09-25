import { writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { addedLineCount } from "../git/diff.js";
import { buildScmPort } from "../scm/build.js";
import { reviewerComment } from "../scm/comment-format.js";
import type { CommentSignal } from "../scm/port.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import {
  appendRecord,
  readRecords,
  renderStats,
  summarize,
  type StatsRecord,
} from "../stats/record.js";

export interface StatsOptions {
  report?: string;
  backfill: boolean;
}

/** Reconstructs a record from the reviewer's own marked comments on this PR. */
export function recordFromSignals(
  author: string,
  addedLines: number,
  at: string,
  signals: readonly CommentSignal[],
): StatsRecord {
  const bySeverity: Partial<Record<Severity, number>> = {};
  const byGuideline: Record<string, number> = {};
  for (const signal of signals) {
    const own = reviewerComment(signal);
    if (own === undefined) continue;
    const severity = own.parsed?.severity;
    if (severity !== undefined) bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    const guidelineId = own.parsed?.guidelineId ?? "(observation)";
    byGuideline[guidelineId] = (byGuideline[guidelineId] ?? 0) + 1;
  }
  return { at, author, addedLines, bySeverity, byGuideline };
}

async function backfill(deps: RuntimeDeps, cwd: string, statsPath: string): Promise<number> {
  const config = deps.loadConfig();
  if (config.scm.provider === "local") {
    throw new ToolError("stats backfill reads a pull request's comments; local mode has none");
  }
  const scm = deps.scmPort ?? buildScmPort(config, deps.credentials, deps.ciBuildUrl);
  if (scm.listCommentSignals === undefined || scm.getPullRequestAuthor === undefined) {
    throw new ToolError(`the ${config.scm.provider} provider cannot back stats out yet`);
  }
  const signals = await scm.listCommentSignals();
  const marked = signals.filter((signal) => reviewerComment(signal) !== undefined);
  if (marked.length === 0) {
    deps.out("nothing to backfill: no marked reviewer comments on this pull request\n");
    return 0;
  }
  const author = await scm.getPullRequestAuthor();
  const diff = scm.fetchPullRequestDiff ? await scm.fetchPullRequestDiff() : "";
  const record = recordFromSignals(
    author === "" ? "(unknown)" : author,
    addedLineCount(diff),
    (deps.clock?.() ?? new Date()).toISOString(),
    marked,
  );
  await appendRecord(cwd, statsPath, record);
  const total = Object.values(record.byGuideline).reduce((sum, count) => sum + count, 0);
  deps.out(`backfilled ${String(total)} finding(s) from this pull request into ${statsPath}\n`);
  return 0;
}

export async function runStats(deps: RuntimeDeps, options: StatsOptions): Promise<number> {
  const config = deps.loadConfig();
  const statsPath = config.stats.path;
  if (options.backfill) return backfill(deps, deps.cwd, statsPath);

  const summaries = summarize(readRecords(deps.cwd, statsPath));
  deps.out(renderStats(summaries));
  if (options.report !== undefined) {
    writeFileSync(
      path.resolve(deps.cwd, options.report),
      `${JSON.stringify({ contributors: summaries, severities: SEVERITIES }, null, 2)}\n`,
    );
  }
  return 0;
}
