import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBacktestCases, type BacktestCase } from "../src/backtest/cases.js";
import { materialize, missingLines, replayCase } from "../src/backtest/replay.js";
import { drift, findingKey, scoreRun, type ReplayedFinding } from "../src/backtest/score.js";
import { BASELINE_FILE, runBacktestCommand } from "../src/commands/backtest.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { testDeps } from "./helpers/deps.js";
import { git } from "./helpers/git.js";

const GUIDELINE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

const CONFIG = `scm:
  provider: local
review:
  target: main
  include: ['src/**']
`;

const BASE_APP = "function greet(name) {\n  return name;\n}\n";
const PR_APP = "function greet(name) {\n  console.log(name);\n  return name;\n}\n";

const CONSOLE_FINDING = {
  guidelineId: "no-console",
  file: "src/app.js",
  line: 2,
  quote: "console.log(name);",
  title: "Console call added",
  body: "Replace the console.log with the logger.",
  guidelineQuote: "Use the logger instead.",
};

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** The diff a pull request makes from BASE_APP to the given text. */
function diffOf(after: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "bt-diff-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, "src/app.js", BASE_APP);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=f", "-c", "user.email=f@e", "commit", "-q", "-m", "base");
  write(repo, "src/app.js", after);
  return git(repo, "diff");
}

interface CaseSpec {
  after?: string;
  expected?: unknown;
  config?: string;
}

function makeCases(specs: Record<string, CaseSpec>): string {
  const casesDir = mkdtempSync(path.join(tmpdir(), "bt-cases-"));
  for (const [name, spec] of Object.entries(specs)) {
    const dir = path.join(casesDir, name);
    write(dir, "base/src/app.js", BASE_APP);
    write(dir, "base/guidelines/no-console.md", GUIDELINE);
    write(dir, "base/delta-peacock.config.yaml", spec.config ?? CONFIG);
    write(dir, "diff.patch", diffOf(spec.after ?? PR_APP));
    write(
      dir,
      "expected.json",
      JSON.stringify(spec.expected ?? { findings: [{ file: "src/app.js", line: 2 }] }),
    );
  }
  return casesDir;
}

function scripted(...texts: string[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let call = 0;
  return {
    requests,
    port: {
      complete: (request) => {
        requests.push(request);
        const text = texts[Math.min(call, texts.length - 1)] ?? "";
        call += 1;
        return Promise.resolve({ text, usage: { inputTokens: 1000, outputTokens: 100 } });
      },
    },
  };
}

const found = (findings: unknown[]): string => JSON.stringify({ findings });

function capture(): { out: string[]; err: string[]; text: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, text: () => out.join("") };
}

describe("backtest cases", () => {
  it("loads cases in name order and filters by name", () => {
    const dir = makeCases({ b: {}, a: {} });
    expect(loadBacktestCases(dir).map((one) => one.name)).toEqual(["a", "b"]);
    expect(loadBacktestCases(dir, ["b"]).map((one) => one.name)).toEqual(["b"]);
    expect(loadBacktestCases(dir)[0]?.noFinding).toEqual([]);
  });

  it("refuses a missing directory, a missing part, a bad judgement and an unknown name", () => {
    expect(() => loadBacktestCases("/no/such/dir")).toThrow(/not found/);
    const dir = makeCases({ a: {} });
    expect(() => loadBacktestCases(dir, ["zz"])).toThrow(/no such backtest case: zz/);
    writeFileSync(path.join(dir, "a", "expected.json"), "{");
    expect(() => loadBacktestCases(dir)).toThrow(/not valid JSON/);
    writeFileSync(
      path.join(dir, "a", "expected.json"),
      JSON.stringify({ findings: [{ line: 0 }] }),
    );
    expect(() => loadBacktestCases(dir)).toThrow(/findings\.0\.file/);
    rmSync(path.join(dir, "a", "expected.json"));
    expect(() => loadBacktestCases(dir)).toThrow(/expected\.json is missing/);
    rmSync(path.join(dir, "a", "base"), { recursive: true });
    expect(() => loadBacktestCases(dir)).toThrow(/base\/ is missing/);
    const empty = mkdtempSync(path.join(tmpdir(), "bt-empty-"));
    mkdirSync(path.join(empty, "no-diff"));
    expect(() => loadBacktestCases(empty)).toThrow(/no cases found/);
  });
});

describe("scoring a replay", () => {
  const at = (line: number, extra: Partial<ReplayedFinding> = {}): ReplayedFinding => ({
    file: "a.ts",
    line,
    guidelineId: "g",
    severity: "MINOR",
    title: "t",
    body: "b",
    ...extra,
  });

  it("counts a finding on the expected span as right and names every wrong one", () => {
    const score = scoreRun(
      [at(4), at(5), at(9), at(20), at(30, { guidelineId: "other" })],
      [{ file: "a.ts", line: 3, endLine: 5, guidelineId: "g" }],
      [
        { file: "a.ts", line: 9, guidelineId: "g", why: "judged fine" },
        { file: "a.ts", line: 20 },
      ],
    );
    expect(score).toMatchObject({ expected: 1, found: 5, right: 1, missed: [] });
    expect(score.wrong.map((entry) => entry.reason)).toEqual([
      "a second finding on a span already flagged",
      "judged wrong before: judged fine",
      "judged wrong before",
      "not in the human judgement",
    ]);
  });

  it("holds severity, wording and suggestion to the judgement", () => {
    const want = {
      file: "a.ts",
      line: 1,
      severity: "MAJOR" as const,
      mustMention: ["toHaveURL"],
      mustNotSuggest: ["toHaveAttribute"],
    };
    expect(scoreRun([at(1)], [want], []).wrong[0]?.reason).toBe(
      "severity MINOR, the judgement says MAJOR",
    );
    expect(scoreRun([at(1, { severity: "MAJOR" })], [want], []).wrong[0]?.reason).toBe(
      "does not mention toHaveURL",
    );
    const suggested = at(1, {
      severity: "MAJOR",
      body: "use toHaveURL",
      suggestion: "await expect(x).toHaveAttribute('href')",
    });
    expect(scoreRun([suggested], [want], []).wrong[0]?.reason).toBe("suggests toHaveAttribute");
    const right = at(1, { severity: "MAJOR", body: "Use toHaveURL on the page." });
    expect(scoreRun([right], [want], [])).toMatchObject({ right: 1, wrong: [] });
  });

  it("lists what nobody found as missed", () => {
    const score = scoreRun([], [{ file: "a.ts", line: 1 }], []);
    expect(score.missed).toHaveLength(1);
  });

  it("measures drift as the findings missing from some repeats", () => {
    expect(findingKey(at(3))).toBe("a.ts:3:g");
    const observation: ReplayedFinding = {
      file: "a.ts",
      line: 3,
      severity: "INFO",
      title: "t",
      body: "b",
    };
    expect(findingKey(observation)).toBe("a.ts:3:-");
    expect(drift([])).toBe(0);
    expect(drift([[at(1)], [at(1)]])).toBe(0);
    expect(drift([[at(1), at(2)], [at(1)], [at(1), at(3)]])).toBe(2);
  });
});

describe("replaying a case", () => {
  it("commits the target, applies the pull request above it, and puts a config under test on the target", () => {
    const benchCase = firstCase(makeCases({ a: {} }));
    const repo = path.join(mkdtempSync(path.join(tmpdir(), "bt-repo-")), "repo");
    materialize(benchCase, repo, "review:\n  target: main\n");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("pull-request");
    expect(git(repo, "show", "main:delta-peacock.config.yaml")).toBe("review:\n  target: main\n");
    expect(git(repo, "diff", "main...HEAD", "--name-only").trim()).toBe("src/app.js");
  });

  it("runs the real review in dry run and reads its findings, cost and log", async () => {
    const config = `${CONFIG}context:\n  provider: full_files\ncost:\n  rateInputPer1M: 1\n  rateOutputPer1M: 5\nstats:\n  enabled: true\n`;
    const benchCase = firstCase(makeCases({ a: { config } }));
    const model = scripted(found([{ ...CONSOLE_FINDING, suggestion: "  logger.info(name);" }]));
    const work = mkdtempSync(path.join(tmpdir(), "bt-work-"));
    const replay = await replayCase(testDeps(work, {}, { modelPort: model.port }), benchCase, work);
    expect(replay.error).toBeUndefined();
    expect(replay.findings).toEqual([
      expect.objectContaining({
        file: "src/app.js",
        line: 2,
        guidelineId: "no-console",
        severity: "MAJOR",
        suggestion: "  logger.info(name);",
      }),
    ]);
    expect(replay.cost).toBeCloseTo(0.0015);
    expect(replay.problems).toEqual([]);
    expect(replay.log).toMatch(/^full_files context: 1 changed file\(s\)/m);
    expect(replay.log).toMatch(
      /^cost: 1000 tokens in, 100 out on .+, 0\.0015 USD; \d{4}-\d{2} spend/m,
    );
    expect(replay.log).toMatch(/^stats: review recorded in delta-peacock\.stats\.jsonl/m);
    expect(replay.report).toContain('"findings"');
  });

  it("names the lines a finished review failed to print", () => {
    const config = replayConfig(
      `${CONFIG}context:\n  provider: full_files\ncost:\n  rateInputPer1M: 1\nstats:\n  enabled: true\n  path: nested/stats.jsonl\n`,
    );
    const work = mkdtempSync(path.join(tmpdir(), "bt-work-"));
    expect(missingLines(config, "", work, true)).toEqual([
      "no full_files context line in the log",
      "no cost line in the log",
      "no stats line in the log",
      "no stats record at nested/stats.jsonl",
    ]);
    // a run that never reached the model owes none of them
    expect(missingLines(config, "", work, false)).toEqual([]);
  });

  it("records a review that threw instead of finishing", async () => {
    const benchCase = firstCase(makeCases({ a: {} }));
    const broken: ModelPort = { complete: () => Promise.reject(new Error("bedrock is down")) };
    const work = mkdtempSync(path.join(tmpdir(), "bt-work-"));
    const replay = await replayCase(testDeps(work, {}, { modelPort: broken }), benchCase, work);
    expect(replay.error).toMatch(/bedrock is down/);
    expect(replay.findings).toEqual([]);
  });
});

function firstCase(dir: string): BacktestCase {
  const [first] = loadBacktestCases(dir);
  if (first === undefined) throw new Error("no case");
  return first;
}

function replayConfig(text: string) {
  const root = mkdtempSync(path.join(tmpdir(), "bt-config-"));
  writeFileSync(path.join(root, "delta-peacock.config.yaml"), text);
  return testDeps(root).loadConfig();
}

describe("the backtest command", () => {
  const options = (cases: string) => ({
    cases,
    repeats: 2,
    concurrency: 2,
    version: "9.9.9",
  });

  it("fails on a wrong finding, naming it, and writes the logs and the report", async () => {
    const dir = makeCases({
      a: {},
      b: { after: BASE_APP.replace("name;", "name + 1;"), expected: { findings: [] } },
    });
    const io = capture();
    const model = scripted(found([CONSOLE_FINDING]));
    const report = path.join(dir, "..", `${path.basename(dir)}-report.json`);
    const code = await runBacktestCommand(
      {
        ...testDeps(dir, {}, { modelPort: model.port }),
        out: (text) => io.out.push(text),
        err: (text) => io.err.push(text),
        clock: () => new Date("2026-09-25T12:00:00Z"),
      },
      { ...options(dir), report },
    );
    // b gets the same scripted finding although the human judged b clean
    expect(code).toBe(2);
    expect(io.text()).toContain(
      "| case | expected | found | right | wrong | missed | drift | time | cost |",
    );
    expect(io.text()).toMatch(
      /b r1 wrong: src\/app\.js:2 no-console MAJOR "Console call added", not in the human judgement/,
    );
    expect(existsSync(path.join(dir, BASELINE_FILE))).toBe(false);
    const summary = JSON.parse(readFileSync(report, "utf8")) as {
      passed: boolean;
      cases: unknown[];
    };
    expect(summary.passed).toBe(false);
    expect(summary.cases).toHaveLength(2);
    expect(existsSync(path.join(dir, "runs", "2026-09-25T12-00-00", "a.r1.log"))).toBe(true);
    expect(io.err.join("")).toMatch(/backtest: a\.r1 1 found, 0 wrong, 0 missed/);
  });

  it("writes the baseline on a pass and fails a later run whose recall fell under it", async () => {
    const dir = makeCases({ a: {} });
    const good = scripted(found([CONSOLE_FINDING]));
    const io = capture();
    const deps = {
      ...testDeps(dir, {}, { modelPort: good.port }),
      out: (text: string) => io.out.push(text),
      err: () => undefined,
    };
    expect(await runBacktestCommand(deps, options(dir))).toBe(0);
    const baseline = JSON.parse(readFileSync(path.join(dir, BASELINE_FILE), "utf8")) as {
      recall: number;
      version: string;
      cases: Record<string, { recall: number }>;
    };
    expect(baseline).toMatchObject({ recall: 1, version: "9.9.9", cases: { a: { recall: 1 } } });
    expect(io.text()).toContain("backtest passed; baseline written");

    const silent = scripted(found([]));
    const later = capture();
    const code = await runBacktestCommand(
      { ...deps, modelPort: silent.port, out: (text) => later.out.push(text) },
      options(dir),
    );
    expect(code).toBe(2);
    expect(later.text()).toContain("recall 0% is below the baseline 100% of 9.9.9");
    expect(later.text()).toContain("a recall 0% is below its baseline 100%");
    expect(later.text()).toMatch(/a r1 missed: src\/app\.js:2 any guideline/);
  });

  it("flags drift across repeats and leaves the baseline alone on a subset", async () => {
    const dir = makeCases({ a: {}, b: {} });
    const flaky = scripted(found([CONSOLE_FINDING]), found([]));
    const io = capture();
    const code = await runBacktestCommand(
      {
        ...testDeps(dir, {}, { modelPort: flaky.port }),
        out: (text) => io.out.push(text),
        err: () => undefined,
      },
      { ...options(dir), only: ["a"], concurrency: 1 },
    );
    expect(code).toBe(2);
    expect(io.text()).toContain("a drift: 1 finding(s) not in every repeat");

    const steady = scripted(found([CONSOLE_FINDING]));
    const again = capture();
    expect(
      await runBacktestCommand(
        {
          ...testDeps(dir, {}, { modelPort: steady.port }),
          out: (t) => again.out.push(t),
          err: () => undefined,
        },
        { ...options(dir), only: ["a"] },
      ),
    ).toBe(0);
    expect(again.text()).toContain("the baseline stays as it was");
    expect(existsSync(path.join(dir, BASELINE_FILE))).toBe(false);
  });

  it("runs every case under a config file given on the command line", async () => {
    const dir = makeCases({ a: { config: "scm:\n  provider: github\n" } });
    const override = path.join(dir, "..", `${path.basename(dir)}.yaml`);
    writeFileSync(override, CONFIG);
    const model = scripted(found([CONSOLE_FINDING]));
    const code = await runCli(
      ["backtest", "--cases", dir, "--config", override, "--repeats", "1", "--only", "a"],
      { cwd: dir, env: {}, out: () => undefined, err: () => undefined, modelPort: model.port },
    );
    expect(code).toBe(0);
    expect(model.requests).toHaveLength(1);
  });

  it("names a review that threw, an observation, and a miss with its severity and why", async () => {
    const dir = makeCases({
      a: {
        config: `${CONFIG}  generalPass: true\n`,
        expected: {
          findings: [
            {
              file: "src/app.js",
              line: 9,
              endLine: 9,
              guidelineId: "no-console",
              severity: "MAJOR",
              why: "judged",
            },
          ],
        },
      },
      b: { after: BASE_APP.replace("name;", "name + 1;"), expected: { findings: [] } },
    });
    const observation = { ...CONSOLE_FINDING, guidelineId: undefined, severity: "MINOR" };
    const port: ModelPort = {
      complete: (request) =>
        request.user.includes("name + 1")
          ? Promise.reject(new Error("bedrock is down"))
          : Promise.resolve({ text: found([observation]) }),
    };
    const io = capture();
    const code = await runBacktestCommand(
      {
        ...testDeps(dir, {}, { modelPort: port }),
        out: (t) => io.out.push(t),
        err: () => undefined,
      },
      { ...options(dir), repeats: 1 },
    );
    expect(code).toBe(2);
    expect(io.text()).toMatch(/b r1 review failed: .*bedrock is down/);
    expect(io.text()).toMatch(/a r1 wrong: src\/app\.js:2 observation MINOR "Console call added"/);
    expect(io.text()).toContain("a r1 missed: src/app.js:9 no-console MAJOR, judged");
  });

  it("refuses a nonsense repeat or concurrency count and a broken baseline", async () => {
    const dir = makeCases({ a: {} });
    const deps = testDeps(dir);
    await expect(runBacktestCommand(deps, { ...options(dir), repeats: 0 })).rejects.toThrow(
      /--repeats/,
    );
    await expect(runBacktestCommand(deps, { ...options(dir), concurrency: 1.5 })).rejects.toThrow(
      /--concurrency/,
    );
    writeFileSync(path.join(dir, BASELINE_FILE), "{");
    const model = scripted(found([CONSOLE_FINDING]));
    await expect(
      runBacktestCommand(
        { ...testDeps(dir, {}, { modelPort: model.port }), err: () => undefined },
        options(dir),
      ),
    ).rejects.toThrow(/baseline\.json: not valid JSON/);
  });
});
