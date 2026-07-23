import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../domain/finding.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import { withLock } from "../util/lockfile.js";

export const DEFAULT_STATS_PATH = "delta-peacock.stats.jsonl";

/** One review's contribution to the ledger; no PII beyond the author handle. */
export interface StatsRecord {
  at: string;
  author: string;
  addedLines: number;
  /** Counts per severity for the findings that survived to the gate. */
  bySeverity: Partial<Record<Severity, number>>;
  /** Counts per cited guideline id; observations bucket under "(observation)". */
  byGuideline: Record<string, number>;
}

export function severityCounts(findings: readonly Finding[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

export function guidelineCounts(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const key = finding.kind === "violation" ? finding.guidelineId : "(observation)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function appendRecord(cwd: string, relPath: string, record: StatsRecord): void {
  const full = path.resolve(cwd, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  withLock(full, () => {
    appendFileSync(full, `${JSON.stringify(record)}\n`);
  });
}

/** Yields records one line at a time, so a long ledger never loads whole. */
export function* readRecords(cwd: string, relPath: string): Generator<StatsRecord> {
  const full = path.resolve(cwd, relPath);
  if (!existsSync(full)) return;
  for (const line of readFileSync(full, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as StatsRecord;
      if (typeof parsed.author === "string" && typeof parsed.addedLines === "number") {
        yield parsed;
      }
    } catch {
      // a malformed line is skipped, never fatal to the whole report
    }
  }
}

export interface ContributorSummary {
  author: string;
  reviews: number;
  addedLines: number;
  findings: number;
  bySeverity: Partial<Record<Severity, number>>;
  byGuideline: Record<string, number>;
  /** Findings per hundred added lines; the raw denominator sits beside it. */
  per100Lines: number;
}

function addInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

/** Folds the ledger into a per-author view without holding it all in memory. */
export function summarize(records: Iterable<StatsRecord>): ContributorSummary[] {
  const byAuthor = new Map<string, ContributorSummary>();
  for (const record of records) {
    const author = record.author === "" ? "(unknown)" : record.author;
    const summary = byAuthor.get(author) ?? {
      author,
      reviews: 0,
      addedLines: 0,
      findings: 0,
      bySeverity: {},
      byGuideline: {},
      per100Lines: 0,
    };
    summary.reviews += 1;
    summary.addedLines += record.addedLines;
    for (const [severity, count] of Object.entries(record.bySeverity)) {
      summary.bySeverity[severity as Severity] =
        (summary.bySeverity[severity as Severity] ?? 0) + count;
      summary.findings += count;
    }
    addInto(summary.byGuideline, record.byGuideline);
    byAuthor.set(author, summary);
  }
  const summaries = [...byAuthor.values()];
  for (const summary of summaries) {
    summary.per100Lines =
      summary.addedLines > 0 ? (summary.findings / summary.addedLines) * 100 : 0;
  }
  return summaries.sort((a, b) => b.findings - a.findings);
}

/**
 * A coaching aid, not a ranking: normalized and raw numbers sit together, so a
 * hot ratio on a tiny diff cannot masquerade as a trend.
 */
export function renderStats(summaries: readonly ContributorSummary[]): string {
  if (summaries.length === 0) return "no stats recorded yet\n";
  const lines = ["Contributor stats (a coaching aid, not a ranking):", ""];
  for (const summary of summaries) {
    lines.push(
      `${summary.author}: ${String(summary.findings)} finding(s) over ${String(summary.addedLines)} added line(s) in ${String(summary.reviews)} review(s) — ${summary.per100Lines.toFixed(1)} per 100 lines`,
    );
    const severities = SEVERITIES.filter((severity) => summary.bySeverity[severity] !== undefined)
      .map((severity) => `${severity} ${String(summary.bySeverity[severity])}`)
      .join(", ");
    if (severities !== "") lines.push(`  by severity: ${severities}`);
    const guidelines = Object.entries(summary.byGuideline)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => `${id} ${String(count)}`)
      .join(", ");
    if (guidelines !== "") lines.push(`  by guideline: ${guidelines}`);
  }
  lines.push("");
  return lines.join("\n");
}
