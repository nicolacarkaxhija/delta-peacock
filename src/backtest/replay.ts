import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { activeStrategies } from "../context/build.js";
import type { RuntimeDeps } from "../deps.js";
import { runGit } from "../git/git.js";
import { anyRateConfigured, modelRates } from "../model/usage.js";
import type { ReviewReport } from "../review/report.js";
import { runReview } from "../review/run-review.js";
import type { BacktestCase } from "./cases.js";
import { rerunProblems } from "./rerun.js";
import type { ReplayedFinding } from "./score.js";

const IDENTITY = ["-c", "user.name=backtest", "-c", "user.email=backtest@localhost"];

export interface Replay {
  findings: ReplayedFinding[];
  /** Everything the review printed, notices included. */
  log: string;
  /** The review's JSON report as written, when the run got that far. */
  report?: string;
  milliseconds: number;
  /** USD, when the config prices tokens. */
  cost?: number;
  /** Set when the review threw instead of finishing. */
  error?: string;
  /** Lines the run must print and did not. */
  problems: string[];
}

/**
 * The target tree committed on main, the pull request applied on a branch
 * above it. A config under test lands on main after the branch point, so the
 * review reads it from the target while the diff stays the pull request's own.
 */
export function materialize(benchCase: BacktestCase, repo: string, configText?: string): void {
  mkdirSync(repo, { recursive: true });
  cpSync(benchCase.baseDir, repo, { recursive: true });
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A", "-f"]);
  runGit(repo, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "target"]);
  runGit(repo, ["checkout", "-q", "-b", "pull-request"]);
  runGit(repo, ["apply", "--binary", "--whitespace=nowarn", path.resolve(benchCase.diffPath)]);
  runGit(repo, ["add", "-A", "-f"]);
  runGit(repo, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "pull request"]);
  if (configText === undefined) return;
  runGit(repo, ["checkout", "-q", "main"]);
  writeFileSync(path.join(repo, CONFIG_FILE_NAME), configText);
  runGit(repo, ["add", "-A", "-f"]);
  runGit(repo, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "config under test"]);
  runGit(repo, ["checkout", "-q", "pull-request"]);
}

/** Settings a replay always runs under: local, dry, uncached, config and spend kept in the sandbox. */
function forcedFlags(work: string): Record<string, string> {
  return {
    "scm.provider": "local",
    "scm.dryRun": "true",
    "review.target": "main",
    "review.fetchTarget": "false",
    "cache.enabled": "false",
    "output.report": path.join(work, "report.json"),
    "cost.counterPath": path.join(work, "spend.json"),
  };
}

/** What a finished review must have said about its context, cost and stats. */
export function missingLines(
  config: Config,
  log: string,
  repo: string,
  calledModel: boolean,
): string[] {
  if (!calledModel) return [];
  const problems: string[] = [];
  if (activeStrategies(config).includes("full_files") && !/^full_files context: /m.test(log)) {
    problems.push("no full_files context line in the log");
  }
  if (anyRateConfigured(modelRates(config)) && !/^cost: .+ tokens in, .+ USD; /m.test(log)) {
    problems.push("no cost line in the log");
  }
  if (config.stats.enabled) {
    if (!/^stats: /m.test(log)) problems.push("no stats line in the log");
    if (!existsSync(path.resolve(repo, config.stats.path))) {
      problems.push(`no stats record at ${config.stats.path}`);
    }
  }
  return problems;
}

/**
 * Replays one case through the real review command in a sandbox: the same
 * pipeline a pull request runs, with local SCM and dry run, so nothing leaves.
 */
export async function replayCase(
  deps: RuntimeDeps,
  benchCase: BacktestCase,
  work: string,
  configText?: string,
): Promise<Replay> {
  const repo = path.join(work, "repo");
  materialize(benchCase, repo, configText);
  const chunks: string[] = [];
  const capture = (text: string): void => {
    chunks.push(text);
  };
  const forced = forcedFlags(work);
  const replayDeps: RuntimeDeps = {
    ...deps,
    cwd: repo,
    out: capture,
    err: capture,
    loadConfig: (flags) =>
      loadConfig({
        root: repo,
        env: {},
        flags: { ...flags, ...forced },
        onNotice: (notice) => {
          capture(`${notice}\n`);
        },
      }),
  };
  const startedAt = performance.now();
  let error: string | undefined;
  try {
    // every refused candidate lands in the log, so a miss can be traced to its drop
    await runReview(replayDeps, {}, { explainDrops: true });
  } catch (caught) {
    error = (caught as Error).message;
  }
  const milliseconds = Math.round(performance.now() - startedAt);
  const log = chunks.join("");
  const reportPath = path.join(work, "report.json");
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined;
  const report = reportText !== undefined ? (JSON.parse(reportText) as ReviewReport) : undefined;
  const findings: ReplayedFinding[] = (report?.findings ?? []).map((finding) => ({
    file: finding.file,
    line: finding.line,
    ...(finding.kind === "violation" ? { guidelineId: finding.guidelineId } : {}),
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
  }));
  const config = replayDeps.loadConfig();
  const problems = missingLines(config, log, repo, report?.usage !== undefined);
  if (report !== undefined && benchCase.previous.length > 0) {
    const lineTextOf = (file: string, line: number): string | undefined => {
      const target = path.join(repo, file);
      return existsSync(target) ? readFileSync(target, "utf8").split("\n")[line - 1] : undefined;
    };
    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    problems.push(...(await rerunProblems(benchCase.previous, report.findings, lineTextOf, head)));
  }
  return {
    findings,
    log,
    ...(reportText !== undefined ? { report: reportText } : {}),
    milliseconds,
    ...(report?.cost !== undefined ? { cost: report.cost.total } : {}),
    ...(error !== undefined ? { error } : {}),
    problems,
  };
}
