import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
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

export interface CaseOutcome {
  name: string;
  milliseconds: number;
  produced: ProducedFinding[];
  score?: MatchResult;
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

export type ReviewFn = (benchCase: BenchCase) => Promise<ProducedFinding[]>;

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
  for (const benchCase of cases) {
    const startedAt = performance.now();
    const produced = await review(benchCase);
    const milliseconds = Math.round(performance.now() - startedAt);
    const outcome: CaseOutcome = { name: benchCase.name, milliseconds, produced };
    if (benchCase.expected !== undefined) {
      outcome.score = scoreFindings(produced, benchCase.expected, lineTolerance);
      aggregateProduced = [...aggregateProduced, ...produced];
      aggregateExpected = [...aggregateExpected, ...benchCase.expected];
      scoredAny = true;
    }
    outcomes.push(outcome);
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
    "| case | findings | precision | recall | f1 | time |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const caseOutcome of outcome.cases) {
    const score = caseOutcome.score;
    lines.push(
      `| ${caseOutcome.name} | ${String(caseOutcome.produced.length)} | ${
        score ? percent(score.precision) : "-"
      } | ${score ? percent(score.recall) : "-"} | ${score ? percent(score.f1) : "-"} | ${String(caseOutcome.milliseconds)}ms |`,
    );
  }
  if (outcome.aggregate) {
    lines.push(
      `| aggregate | | ${percent(outcome.aggregate.precision)} | ${percent(outcome.aggregate.recall)} | ${percent(outcome.aggregate.f1)} | |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
