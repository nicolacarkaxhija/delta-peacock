import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { addedLineCount } from "../git/diff.js";
import { buildScmPort } from "../scm/build.js";
import type { CommentSignal } from "../scm/port.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import {
  appendRecord,
  readRecords,
  renderStats,
  summarize,
  type StatsRecord,
} from "../stats/record.js";

const FINDING_MARKER = /<!-- delta-peacock:finding:[0-9a-f]+(?:-\d+)? -->/;
const SEVERITY_LEAD = /^\*\*(BLOCKER|CRITICAL|MAJOR|MINOR|INFO)\*\*/;
const CITED_ID = /`([a-z0-9][a-z0-9-]*)`/;

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
    if (!FINDING_MARKER.test(signal.body)) continue;
    const firstLine = String(signal.body.split("\n")[0]);
    const severity = SEVERITY_LEAD.exec(firstLine)?.[1] as Severity | undefined;
    if (severity !== undefined) bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    const guidelineId = CITED_ID.exec(firstLine)?.[1] ?? "(observation)";
    byGuideline[guidelineId] = (byGuideline[guidelineId] ?? 0) + 1;
  }
  return { at, author, addedLines, bySeverity, byGuideline };
}

async function backfill(deps: RuntimeDeps, cwd: string, statsPath: string): Promise<number> {
  const config = loadConfig({ root: deps.cwd, env: deps.env });
  if (config.scm.provider === "local") {
    throw new ToolError("stats backfill reads a pull request's comments; local mode has none");
  }
  const scm = deps.scmPort ?? buildScmPort(config, deps.env);
  if (scm.listCommentSignals === undefined || scm.getPullRequestAuthor === undefined) {
    throw new ToolError(`the ${config.scm.provider} provider cannot back stats out yet`);
  }
  const signals = await scm.listCommentSignals();
  const marked = signals.filter((signal) => FINDING_MARKER.test(signal.body));
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
  const config = loadConfig({ root: deps.cwd, env: deps.env });
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
