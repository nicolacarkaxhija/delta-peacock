import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../domain/finding.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import type { ModelUsage } from "../model/port.js";
import { withLock } from "../util/lockfile.js";

export const DEFAULT_STATS_PATH = "delta-peacock.stats.jsonl";

/** The pull request a record belongs to; each part only when the SCM provides it. */
export interface PullRequestRef {
  number?: number;
  url?: string;
}

/** Who and what a record is about; every field optional so older lines still read. */
export interface Attribution {
  pr?: PullRequestRef;
  /** The pull request title. */
  title?: string;
  /** From a conventional title `type(scope): ...`; empty when the title has none. */
  scope?: string;
  type?: string;
}

/** One review's contribution to the ledger; no PII beyond the author handle. */
export interface StatsRecord extends Attribution {
  /** Absent on records written before finding lines existed. */
  kind?: "review";
  at: string;
  author: string;
  addedLines: number;
  /** Counts per severity for the findings that survived to the gate. */
  bySeverity: Partial<Record<Severity, number>>;
  /** Counts per cited guideline id; observations bucket under "(observation)". */
  byGuideline: Record<string, number>;
  /** Reviewer errors caught before posting; absent when there were none. */
  errors?: { misquoted: number };
  /** The review model id in use, env override included. */
  model?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** USD; present only when the model has rates. */
  cost?: number;
  durationMs?: number;
}

/** One finding that survived to the gate, one ledger line each. */
export interface FindingRecord extends Attribution {
  kind: "finding";
  at: string;
  author: string;
  /** The cited guideline id; observations use "(observation)". */
  guideline: string;
  severity: Severity;
  file: string;
  line: number;
}

export type LedgerRecord = StatsRecord | FindingRecord;

const CONVENTIONAL_TITLE = /^\s*([A-Za-z][\w-]*)(?:\(([^)]*)\))?!?:\s/;

/** Type and scope of a conventional title; both empty when the title is not one. */
export function parseConventionalTitle(title: string): { type: string; scope: string } {
  const match = CONVENTIONAL_TITLE.exec(title);
  if (match === null) return { type: "", scope: "" };
  return { type: (match[1] ?? "").toLowerCase(), scope: (match[2] ?? "").trim() };
}

/** Attribution fields from what the SCM knows; a title-less run still gets empty scope and type. */
export function attributionOf(
  pr: PullRequestRef | undefined,
  title: string | undefined,
): Attribution {
  const parsed = parseConventionalTitle(title ?? "");
  return {
    ...(pr !== undefined && (pr.number !== undefined || pr.url !== undefined) ? { pr } : {}),
    ...(title !== undefined ? { title } : {}),
    scope: parsed.scope,
    type: parsed.type,
  };
}

export interface LedgerInput {
  at: string;
  author: string;
  addedLines: number;
  findings: readonly Finding[];
  misquoted: number;
  attribution: Attribution;
  model?: string;
  usage?: ModelUsage;
  cost?: number;
  durationMs?: number;
}

/** The review line followed by one line per finding. */
export function ledgerRecords(input: LedgerInput): LedgerRecord[] {
  const { at, author, attribution } = input;
  const review: StatsRecord = {
    kind: "review",
    at,
    author,
    addedLines: input.addedLines,
    bySeverity: severityCounts(input.findings),
    byGuideline: guidelineCounts(input.findings),
    // an invented rule is a reviewer error, counted apart from the author's findings
    ...(input.misquoted > 0 ? { errors: { misquoted: input.misquoted } } : {}),
    ...attribution,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.usage !== undefined
      ? {
          tokens: {
            input: input.usage.inputTokens,
            output: input.usage.outputTokens,
            cacheRead: input.usage.cacheReadTokens ?? 0,
            cacheWrite: input.usage.cacheWriteTokens ?? 0,
          },
        }
      : {}),
    ...(input.cost !== undefined ? { cost: input.cost } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
  const findings = input.findings.map((finding): FindingRecord => ({
    kind: "finding",
    at,
    author,
    ...attribution,
    guideline: finding.kind === "violation" ? finding.guidelineId : "(observation)",
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
  }));
  return [review, ...findings];
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

export async function appendRecord(
  cwd: string,
  relPath: string,
  record: LedgerRecord | readonly LedgerRecord[],
): Promise<void> {
  const records = Array.isArray(record) ? record : [record];
  const full = path.resolve(cwd, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  await withLock(full, () => {
    appendFileSync(full, records.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  });
}

function* ledgerLines(cwd: string, relPath: string): Generator<Record<string, unknown>> {
  const full = path.resolve(cwd, relPath);
  if (!existsSync(full)) return;
  for (const line of readFileSync(full, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) yield parsed as Record<string, unknown>;
    } catch {
      // a malformed line is skipped, never fatal to the whole report
    }
  }
}

/** Yields review records one line at a time, so a long ledger never loads whole. */
export function* readRecords(cwd: string, relPath: string): Generator<StatsRecord> {
  for (const parsed of ledgerLines(cwd, relPath)) {
    if (typeof parsed["author"] === "string" && typeof parsed["addedLines"] === "number") {
      yield parsed as unknown as StatsRecord;
    }
  }
}

/** Yields the finding lines; ledgers written before them yield nothing. */
export function* readFindings(cwd: string, relPath: string): Generator<FindingRecord> {
  for (const parsed of ledgerLines(cwd, relPath)) {
    if (parsed["kind"] === "finding" && typeof parsed["guideline"] === "string") {
      yield parsed as unknown as FindingRecord;
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
  /** Findings the reviewer invented (quoted rule not in the guideline); present when any. */
  misquoted?: number;
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
    const misquoted = record.errors?.misquoted ?? 0;
    if (misquoted > 0) summary.misquoted = (summary.misquoted ?? 0) + misquoted;
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
    if (summary.misquoted !== undefined) {
      lines.push(
        `  reviewer errors: ${String(summary.misquoted)} finding(s) dropped for quoting a rule the guideline does not have`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
