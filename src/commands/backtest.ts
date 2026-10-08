import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBacktestCases, type BacktestCase, type ExpectedFinding } from "../backtest/cases.js";
import { replayCase, type Replay } from "../backtest/replay.js";
import { drift, scoreFacts, scoreRun, type FactsScore, type RunScore } from "../backtest/score.js";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { inPool } from "../util/pool.js";

export const BASELINE_FILE = "baseline.json";

export interface BacktestOptions {
  cases: string;
  repeats: number;
  /** A config file every case runs under instead of its own base/ config. */
  config?: string;
  /** Case names to run; all when absent. */
  only?: string[];
  concurrency: number;
  report?: string;
  /** The reviewer version the baseline records. */
  version: string;
  /** A model provider every case runs under; none scores the facts only mode. */
  provider?: string;
  /** Lines either side of an expected span a finding may sit on and still count; 0 by default. */
  anchorWindow?: number;
}

interface Run {
  score: RunScore & Partial<Pick<FactsScore, "facts" | "judgement">>;
  replay: Replay;
}

interface CaseResult {
  name: string;
  /** Findings the judgement expects. */
  expected: number;
  runs: Run[];
  drift: number;
  /** The worst repeat's recall; 1 when nothing is expected. */
  recall: number;
}

export interface Baseline {
  version: string;
  at: string;
  repeats: number;
  /** Aggregate recall of the worst repeat, over every case. */
  recall: number;
  precision: number;
  cases: Record<string, { recall: number }>;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole);
const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const perRepeat = (runs: readonly Run[], pick: (run: Run) => number): string =>
  runs.map((run) => String(pick(run))).join("/");

function where(entry: { file: string; line: number; endLine?: number | undefined }): string {
  const span =
    entry.endLine !== undefined && entry.endLine !== entry.line
      ? `${String(entry.line)}-${String(entry.endLine)}`
      : String(entry.line);
  return `${entry.file}:${span}`;
}

function readBaseline(casesDir: string): Baseline | undefined {
  const file = path.join(casesDir, BASELINE_FILE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Baseline;
  } catch (error) {
    throw new ToolError(`${file}: not valid JSON (${(error as Error).message})`);
  }
}

function formatTable(results: readonly CaseResult[]): string {
  const lines = [
    "| case | expected | found | right | wrong | missed | off change | drift | time | cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const runs = result.runs;
    const seconds =
      runs.reduce((sum, run) => sum + run.replay.milliseconds, 0) / runs.length / 1000;
    const cost = runs.reduce((sum, run) => sum + (run.replay.cost ?? 0), 0);
    lines.push(
      `| ${result.name} | ${String(result.expected)} | ${perRepeat(runs, (run) => run.score.found)} | ${perRepeat(runs, (run) => run.score.right)} | ${perRepeat(runs, (run) => run.score.wrong.length)} | ${perRepeat(runs, (run) => run.score.missed.length)} | ${perRepeat(runs, (run) => run.replay.offChange)} | ${String(result.drift)} | ${seconds.toFixed(0)} s | ${cost.toFixed(4)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Every failure in words, each naming the case, the repeat and the finding. */
function failures(results: readonly CaseResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    for (const [index, run] of result.runs.entries()) {
      const tag = `${result.name} r${String(index + 1)}`;
      if (run.replay.error !== undefined) lines.push(`${tag} review failed: ${run.replay.error}`);
      for (const problem of run.replay.problems) lines.push(`${tag} ${problem}`);
      for (const { finding, reason } of run.score.wrong) {
        lines.push(
          `${tag} wrong: ${where(finding)} ${finding.guidelineId ?? "observation"} ${finding.severity} "${finding.title}", ${reason}`,
        );
      }
      for (const want of run.score.missed) lines.push(`${tag} missed: ${describeExpected(want)}`);
    }
    if (result.drift > 0) {
      lines.push(`${result.name} drift: ${String(result.drift)} finding(s) not in every repeat`);
    }
  }
  return lines;
}

function describeExpected(want: ExpectedFinding): string {
  return `${where(want)} ${want.guidelineId ?? "any guideline"}${want.severity !== undefined ? ` ${want.severity}` : ""}${want.why !== undefined ? `, ${want.why}` : ""}`;
}

/** Aggregate recall of each repeat index; the worst one is what the baseline holds. */
function worstRecall(results: readonly CaseResult[], repeats: number): number {
  return Math.min(
    ...Array.from({ length: repeats }, (_, index) => {
      const scores = results
        .map((result) => result.runs[index])
        .filter((run): run is Run => run !== undefined)
        .map((run) => run.score);
      return ratio(
        scores.reduce((sum, score) => sum + score.right, 0),
        scores.reduce((sum, score) => sum + score.expected, 0),
      );
    }),
  );
}

function regressions(
  results: readonly CaseResult[],
  recall: number,
  baseline: Baseline | undefined,
  complete: boolean,
): string[] {
  if (baseline === undefined) return [];
  const lines: string[] = [];
  const epsilon = 1e-9;
  if (complete && recall + epsilon < baseline.recall) {
    lines.push(
      `recall ${pct(recall)} is below the baseline ${pct(baseline.recall)} of ${baseline.version}`,
    );
  }
  for (const result of results) {
    const before = baseline.cases[result.name];
    if (before !== undefined && result.recall + epsilon < before.recall) {
      lines.push(
        `${result.name} recall ${pct(result.recall)} is below its baseline ${pct(before.recall)}`,
      );
    }
  }
  return lines;
}

const sum = (runs: readonly Run[], pick: (run: Run) => number): number =>
  runs.reduce((total, run) => total + pick(run), 0);

/** A facts only backtest: every fact finding found, none wrong, the rest counted, baseline untouched. */
function factsOutcome(
  deps: RuntimeDeps,
  options: BacktestOptions,
  results: readonly CaseResult[],
  runsDir: string,
  now: Date,
): number {
  const lines = [
    "| case | expected | fact | found | right | wrong | missed | judgement | drift |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const runs = result.runs;
    lines.push(
      `| ${result.name} | ${String(result.expected)} | ${perRepeat(runs, (run) => run.score.facts ?? 0)} | ${perRepeat(runs, (run) => run.score.found)} | ${perRepeat(runs, (run) => run.score.right)} | ${perRepeat(runs, (run) => run.score.wrong.length)} | ${perRepeat(runs, (run) => run.score.missed.length)} | ${perRepeat(runs, (run) => run.score.judgement?.length ?? 0)} | ${String(result.drift)} |`,
    );
  }
  const all = results.flatMap((result) => result.runs);
  const totals = {
    expected: sum(all, (run) => run.score.expected),
    facts: sum(all, (run) => run.score.facts ?? 0),
    right: sum(all, (run) => run.score.right),
    wrong: sum(all, (run) => run.score.wrong.length),
    missed: sum(all, (run) => run.score.missed.length),
    judgement: sum(all, (run) => run.score.judgement?.length ?? 0),
    drift: results.reduce((total, result) => total + result.drift, 0),
  };
  deps.out(`${lines.join("\n")}\n`);
  deps.out(
    `facts only over ${String(options.repeats)} repeat(s): ${String(totals.right)} of ${String(totals.facts)} fact findings found, ${String(totals.wrong)} wrong, ${String(totals.judgement)} of ${String(totals.expected)} expected findings need a judgement, drift ${String(totals.drift)}\n`,
  );
  const failed = failures(results);
  for (const line of failed) deps.out(`${line}\n`);
  for (const result of results) {
    for (const want of result.runs[0]?.score.judgement ?? []) {
      deps.out(`${result.name} needs a judgement: ${describeExpected(want)}\n`);
    }
  }
  const summary = {
    version: options.version,
    at: now.toISOString(),
    provider: "none",
    repeats: options.repeats,
    ...totals,
    passed: failed.length === 0,
    failures: failed,
    cases: results.map((result) => ({
      name: result.name,
      expected: result.expected,
      drift: result.drift,
      runs: result.runs.map((run) => ({
        facts: run.score.facts,
        right: run.score.right,
        wrong: run.score.wrong,
        missed: run.score.missed,
        judgement: run.score.judgement,
        problems: run.replay.problems,
        ...(run.replay.error !== undefined ? { error: run.replay.error } : {}),
      })),
    })),
  };
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(path.join(runsDir, "summary.json"), summaryText);
  if (options.report !== undefined)
    writeFileSync(path.resolve(deps.cwd, options.report), summaryText);
  if (failed.length > 0) {
    deps.out(`backtest failed: ${String(failed.length)} problem(s); logs in ${runsDir}\n`);
    return 2;
  }
  deps.out("backtest passed on facts only; the baseline stays as it was\n");
  return 0;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Replays real pull requests through the reviewer and holds it to the human
 * judgement: any wrong finding, any drift across repeats, any missing log
 * line, or recall under the stored baseline fails the run (exit 2).
 */
export async function runBacktestCommand(
  deps: RuntimeDeps,
  options: BacktestOptions,
): Promise<number> {
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new ToolError("--repeats takes a whole number of at least 1");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new ToolError("--concurrency takes a whole number of at least 1");
  }
  const window = options.anchorWindow ?? 0;
  if (!Number.isInteger(window) || window < 0) {
    throw new ToolError("--anchor-window takes a whole number of lines, 0 or more");
  }
  const casesDir = path.resolve(deps.cwd, options.cases);
  const cases = loadBacktestCases(casesDir, options.only);
  const configText =
    options.config !== undefined
      ? readFileSync(path.resolve(deps.cwd, options.config), "utf8")
      : undefined;
  const now = deps.clock?.() ?? new Date();
  const runsDir = path.join(casesDir, "runs", stamp(now));
  mkdirSync(runsDir, { recursive: true });
  const workRoot = mkdtempSync(path.join(tmpdir(), "delta-peacock-backtest-"));

  const jobs = cases.flatMap((benchCase: BacktestCase) =>
    Array.from({ length: options.repeats }, (_, index) => async (): Promise<Run> => {
      const label = `${benchCase.name}.r${String(index + 1)}`;
      const replay = await replayCase(
        deps,
        benchCase,
        path.join(workRoot, label),
        configText,
        options.provider,
      );
      const score =
        replay.facts !== undefined
          ? scoreFacts(
              replay.findings,
              benchCase.expected,
              benchCase.noFinding,
              replay.facts,
              window,
            )
          : scoreRun(replay.findings, benchCase.expected, benchCase.noFinding, window);
      writeFileSync(path.join(runsDir, `${label}.log`), replay.log);
      if (replay.report !== undefined) {
        writeFileSync(path.join(runsDir, `${label}.report.json`), replay.report);
      }
      deps.err(
        `backtest: ${label} ${String(score.found)} found, ${String(score.wrong.length)} wrong, ${String(score.missed.length)} missed, ${(replay.milliseconds / 1000).toFixed(0)} s\n`,
      );
      return { score, replay };
    }),
  );
  let runs: Run[];
  try {
    runs = await inPool(jobs, options.concurrency);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  const results: CaseResult[] = cases.map((benchCase, caseIndex) => {
    const own = runs.slice(caseIndex * options.repeats, (caseIndex + 1) * options.repeats);
    return {
      name: benchCase.name,
      expected: benchCase.expected.length,
      runs: own,
      drift: drift(own.map((run) => run.replay.findings)),
      recall: Math.min(
        ...own.map((run) => ratio(run.score.right, run.score.facts ?? run.score.expected)),
      ),
    };
  });
  if (runs.some((run) => run.score.facts !== undefined)) {
    return factsOutcome(deps, options, results, runsDir, now);
  }
  const recall = worstRecall(results, options.repeats);
  const right = runs.reduce((sum, run) => sum + run.score.right, 0);
  const found = runs.reduce((sum, run) => sum + run.score.found, 0);
  const precision = ratio(right, found);
  const totalDrift = results.reduce((sum, result) => sum + result.drift, 0);
  const cost = runs.reduce((sum, run) => sum + (run.replay.cost ?? 0), 0);
  const offChange = runs.reduce((sum, run) => sum + run.replay.offChange, 0);
  const baseline = readBaseline(casesDir);
  const complete = options.only === undefined;
  const failed = [...failures(results), ...regressions(results, recall, baseline, complete)];

  deps.out(formatTable(results));
  deps.out(
    `precision ${pct(precision)}, recall ${pct(recall)} (worst of ${String(options.repeats)}), drift ${String(totalDrift)}, ${String(offChange)} finding(s) off the change, cost ${cost.toFixed(4)} USD${baseline !== undefined ? `, baseline recall ${pct(baseline.recall)} of ${baseline.version}` : ""}\n`,
  );
  for (const line of failed) deps.out(`${line}\n`);

  const summary = {
    version: options.version,
    at: now.toISOString(),
    repeats: options.repeats,
    anchorWindow: window,
    precision,
    recall,
    drift: totalDrift,
    offChange,
    cost,
    passed: failed.length === 0,
    failures: failed,
    cases: results.map((result) => ({
      name: result.name,
      recall: result.recall,
      drift: result.drift,
      runs: result.runs.map((run) => ({
        milliseconds: run.replay.milliseconds,
        cost: run.replay.cost,
        offChange: run.replay.offChange,
        right: run.score.right,
        wrong: run.score.wrong,
        missed: run.score.missed,
        problems: run.replay.problems,
        ...(run.replay.error !== undefined ? { error: run.replay.error } : {}),
      })),
    })),
  };
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(path.join(runsDir, "summary.json"), summaryText);
  if (options.report !== undefined)
    writeFileSync(path.resolve(deps.cwd, options.report), summaryText);

  if (failed.length > 0) {
    deps.out(`backtest failed: ${String(failed.length)} problem(s); logs in ${runsDir}\n`);
    return 2;
  }
  if (!complete) {
    deps.out("backtest passed on a subset; the baseline stays as it was\n");
    return 0;
  }
  const next: Baseline = {
    version: options.version,
    at: now.toISOString(),
    repeats: options.repeats,
    recall,
    precision,
    cases: Object.fromEntries(results.map((result) => [result.name, { recall: result.recall }])),
  };
  writeFileSync(path.join(casesDir, BASELINE_FILE), `${JSON.stringify(next, null, 2)}\n`);
  deps.out(`backtest passed; baseline written to ${path.join(casesDir, BASELINE_FILE)}\n`);
  return 0;
}
