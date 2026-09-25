import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { ModelUsage } from "../model/port.js";
import {
  scoreFindings,
  type ExpectedFinding,
  type MatchResult,
  type ProducedFinding,
} from "./scoring.js";

export interface BenchCase {
  name: string;
  dir: string;
  diff: string;
  expected?: ExpectedFinding[];
}

/** What a case's review hands back beyond its findings: tokens per model, invented rules caught. */
export interface ReviewResult {
  produced: ProducedFinding[];
  usage?: Record<string, ModelUsage>;
  misquoted?: number;
}

export interface CaseOutcome {
  name: string;
  milliseconds: number;
  produced: ProducedFinding[];
  /** Tokens per model id, for pricing a run. */
  usage?: Record<string, ModelUsage>;
  /** Findings dropped for quoting a rule the guideline does not have. */
  misquoted?: number;
  score?: MatchResult;
  /** Set when this case's review threw (unparseable reply, model error, anything); scored as zero findings. */
  error?: string;
}

export interface BenchOutcome {
  cases: CaseOutcome[];
  aggregate?: MatchResult;
}

/** A case is a directory holding diff.patch, guidelines/, optional files/ and expected.json. */
export function loadCases(casesDir: string): BenchCase[] {
  if (!existsSync(casesDir)) {
    throw new ToolError(`bench cases directory not found: ${casesDir}`);
  }
  const cases: BenchCase[] = [];
  for (const entry of readdirSync(casesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(casesDir, entry.name);
    const diffPath = path.join(dir, "diff.patch");
    if (!existsSync(diffPath)) continue;
    const expectedPath = path.join(dir, "expected.json");
    const expected = existsSync(expectedPath)
      ? (JSON.parse(readFileSync(expectedPath, "utf8")) as { findings: ExpectedFinding[] }).findings
      : undefined;
    cases.push({
      name: entry.name,
      dir,
      diff: readFileSync(diffPath, "utf8"),
      ...(expected !== undefined ? { expected } : {}),
    });
  }
  if (cases.length === 0) {
    throw new ToolError(`no cases found under ${casesDir}; a case holds at least diff.patch`);
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

export type ReviewFn = (benchCase: BenchCase) => Promise<ProducedFinding[] | ReviewResult>;

/** Timing lives here; scoring stays pure so it tests without any review. */
export async function runBench(
  cases: readonly BenchCase[],
  review: ReviewFn,
  lineTolerance = 2,
): Promise<BenchOutcome> {
  const outcomes: CaseOutcome[] = [];
  let aggregateProduced: ProducedFinding[] = [];
  let aggregateExpected: ExpectedFinding[] = [];
  let scoredAny = false;
  let erroredCount = 0;
  for (const benchCase of cases) {
    const startedAt = performance.now();
    // a case's review failing (unparseable reply, model error, anything)
    // costs only this case's score: the other cases were already paid for
    // and must survive alongside it, or one bad case among many (routine
    // once the corpus grows past a handful of cases) would discard a whole
    // benchmark run's worth of real signal
    let produced: ProducedFinding[] = [];
    let extra: Omit<ReviewResult, "produced"> = {};
    let error: string | undefined;
    try {
      const result = await review(benchCase);
      if (Array.isArray(result)) {
        produced = result;
      } else {
        ({ produced, ...extra } = result);
      }
    } catch (caught) {
      error = (caught as Error).message;
      erroredCount += 1;
    }
    const milliseconds = Math.round(performance.now() - startedAt);
    const outcome: CaseOutcome = {
      name: benchCase.name,
      milliseconds,
      produced,
      ...(extra.usage !== undefined ? { usage: extra.usage } : {}),
      ...((extra.misquoted ?? 0) > 0 ? { misquoted: extra.misquoted } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    if (benchCase.expected !== undefined) {
      // zero findings for a crashed case, scored normally against what it owed
      outcome.score = scoreFindings(produced, benchCase.expected, lineTolerance);
      aggregateProduced = [...aggregateProduced, ...produced];
      aggregateExpected = [...aggregateExpected, ...benchCase.expected];
      scoredAny = true;
    }
    outcomes.push(outcome);
  }
  if (cases.length > 0 && erroredCount === cases.length) {
    // every case failed: zero findings across the board would read as a
    // clean (if unimpressive) pass, so this must surface as a hard failure
    // exactly like the old single-case crash did
    throw new ToolError(
      [
        "every case failed to review; nothing to benchmark with",
        ...outcomes.map((outcome) => `${outcome.name}: ${outcome.error ?? "unknown error"}`),
      ].join("\n"),
    );
  }
  return {
    cases: outcomes,
    ...(scoredAny
      ? { aggregate: scoreFindings(aggregateProduced, aggregateExpected, lineTolerance) }
      : {}),
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

export function formatTable(outcome: BenchOutcome): string {
  const lines = [
    "| case | findings | precision | recall | f1 | time | error |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const caseOutcome of outcome.cases) {
    const score = caseOutcome.score;
    lines.push(
      `| ${caseOutcome.name} | ${String(caseOutcome.produced.length)} | ${
        score ? percent(score.precision) : "-"
      } | ${score ? percent(score.recall) : "-"} | ${score ? percent(score.f1) : "-"} | ${String(caseOutcome.milliseconds)}ms | ${
        // a crashed case must read as crashed, never as a genuine clean pass
        caseOutcome.error !== undefined ? `error: ${caseOutcome.error}` : "-"
      } |`,
    );
  }
  if (outcome.aggregate) {
    const erroredCount = outcome.cases.filter(
      (caseOutcome) => caseOutcome.error !== undefined,
    ).length;
    lines.push(
      `| aggregate | | ${percent(outcome.aggregate.precision)} | ${percent(outcome.aggregate.recall)} | ${percent(outcome.aggregate.f1)} | | ${
        erroredCount > 0
          ? `${String(erroredCount)}/${String(outcome.cases.length)} case(s) errored`
          : "-"
      } |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
