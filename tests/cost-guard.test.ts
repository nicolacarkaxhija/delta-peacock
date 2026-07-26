import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { costExplorerMonthToDate } from "../src/cost/cost-explorer.js";
import { monthKey, readMonthSpend, recordSpend } from "../src/cost/counter.js";
import { checkCostGuard } from "../src/cost/guard.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
const CITED = JSON.stringify({
  findings: [{ guidelineId: "no-console", file: "src/app.js", line: 1, title: "t", body: "b" }],
});

function makeScenario(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  commitAll(repo, "change");
  return repo;
}

function counterFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "peacock-spend-")), "spend.json");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  requests: number;
}

async function reviewWith(
  repo: string,
  env: Record<string, string>,
  options: { clock?: () => Date; report?: string } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let requests = 0;
  const port: ModelPort = {
    complete() {
      requests += 1;
      return Promise.resolve({ text: CITED, usage: { inputTokens: 1000, outputTokens: 100 } });
    },
  };
  const code = await runCli(
    ["review", ...(options.report !== undefined ? ["--report", options.report] : [])],
    {
      cwd: repo,
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        ...env,
      },
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
      ...(options.clock ? { clock: options.clock } : {}),
    },
  );
  return { code, stdout, stderr, requests };
}

describe("per-review cap", () => {
  it("blocks before any model call, writes the reason everywhere, exits clean in advisory", async () => {
    const repo = makeScenario();
    const { code, stdout, requests } = await reviewWith(
      repo,
      { DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001" },
      { report: "b.json" },
    );
    expect(code).toBe(0);
    expect(requests).toBe(0); // nothing reached the model
    expect(stdout).toContain("exceeds cost.maxPerReview");
    expect(stdout).toContain("blocked by the cost guard");
    const report = JSON.parse(readFileSync(path.join(repo, "b.json"), "utf8")) as ReviewReport;
    expect(report.budget?.blocked).toBe(true);
    expect(report.budget?.reasons[0]).toContain("maxPerReview");
    expect(report.findings).toEqual([]);
  });

  it("fails loudly when a gate is configured", async () => {
    const repo = makeScenario();
    const { code, requests } = await reviewWith(repo, {
      DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
      DELTA_PEACOCK_GATE_FAIL_ON: "MAJOR",
    });
    expect(code).toBe(1);
    expect(requests).toBe(0);
  });

  it("multiplies the estimate by the ensemble call count", async () => {
    const repo = makeScenario();
    // a cap generous for one call but too small for three members plus a judge
    const single = await checkCostGuard(
      loadConfig({
        root: repo,
        env: {
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        },
      }),
      { system: "s", user: "u" },
      new Date(),
    );
    const ensembled = await checkCostGuard(
      loadConfig({
        root: repo,
        env: {
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
          DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
          DELTA_PEACOCK_ENSEMBLE_MODE: "judge",
          DELTA_PEACOCK_ENSEMBLE_JUDGE: JSON.stringify({ provider: "anthropic", id: "j" }),
          DELTA_PEACOCK_ENSEMBLE_MEMBERS: JSON.stringify([
            { provider: "anthropic", id: "a" },
            { provider: "anthropic", id: "b" },
            { provider: "anthropic", id: "c" },
          ]),
        },
      }),
      { system: "s", user: "u" },
      new Date(),
    );
    expect(ensembled.estimated).toBeCloseTo(single.estimated * 4);
  });

  it("blocks when the planned diff batches push the estimate over the per-review cap", async () => {
    const repo = makeScenario();
    const config = loadConfig({
      root: repo,
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.1",
      },
    });
    const request = { system: "s", user: "u" };
    // one call fits the cap; the same diff split into five batches does not, and
    // the guard must see the five before any model call is made
    const whole = await checkCostGuard(config, request, new Date(), { batches: 1 });
    const batched = await checkCostGuard(config, request, new Date(), { batches: 5 });
    expect(whole.allowed).toBe(true);
    expect(batched.allowed).toBe(false);
    expect(batched.estimated).toBeGreaterThan(whole.estimated);
    expect(batched.reasons.join("\n")).toContain("maxPerReview");
  });

  it("warns when caps are set without rates and lets the review proceed", async () => {
    const repo = makeScenario();
    let stderr = "";
    let requests = 0;
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_COST_MAX_PER_REVIEW: "1" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: {
        complete() {
          requests += 1;
          return Promise.resolve({ text: CITED });
        },
      },
    });
    expect(code).toBe(0);
    expect(requests).toBe(1);
    expect(stderr).toContain("no rates are configured");
  });
});

describe("monthly cap and the counter", () => {
  const JULY = () => new Date(Date.UTC(2026, 6, 15));
  const AUGUST = () => new Date(Date.UTC(2026, 7, 1));

  it("blocks when month-to-date plus the estimate exceeds the cap, and a new month unblocks", async () => {
    const repo = makeScenario();
    const counter = counterFile();
    await recordSpend(counter, monthKey(JULY()), 0.99);
    const env = {
      DELTA_PEACOCK_COST_MONTHLY_CAP: "1",
      DELTA_PEACOCK_COST_COUNTER_PATH: counter,
    };
    const july = await reviewWith(repo, env, { clock: JULY });
    expect(july.code).toBe(0);
    expect(july.requests).toBe(0);
    expect(july.stdout).toContain("monthlyCap");

    const august = await reviewWith(repo, env, { clock: AUGUST });
    expect(august.code).toBe(0);
    expect(august.requests).toBe(1); // the new month reset the ledger
  });

  it("records actual spend per month after a completed review", async () => {
    const repo = makeScenario();
    const counter = counterFile();
    const env = { DELTA_PEACOCK_COST_COUNTER_PATH: counter };
    await reviewWith(repo, env, { clock: JULY });
    await reviewWith(repo, env, { clock: JULY });
    const perReview = (1000 / 1e6) * 3 + (100 / 1e6) * 15;
    expect(readMonthSpend(counter, monthKey(JULY()))).toBeCloseTo(perReview * 2);
  });

  it("survives a corrupt counter file", async () => {
    const counter = counterFile();
    writeFileSync(counter, "{nope");
    expect(readMonthSpend(counter, "2026-07")).toBe(0);
    await recordSpend(counter, "2026-07", 0.5);
    expect(readMonthSpend(counter, "2026-07")).toBeCloseTo(0.5);
  });
});

describe("cost explorer source", () => {
  it("sums month-to-date bedrock spend from the api", async () => {
    const inputs: unknown[] = [];
    const total = await costExplorerMonthToDate(new Date(Date.UTC(2026, 6, 15)), (input) => {
      inputs.push(input);
      return Promise.resolve({
        ResultsByTime: [{ Total: { UnblendedCost: { Amount: "12.34" } } }],
      });
    });
    expect(total).toBeCloseTo(12.34);
    expect(JSON.stringify(inputs[0])).toContain("2026-07-01");
    expect(JSON.stringify(inputs[0])).toContain("Amazon Bedrock");
  });

  it("uses the cost explorer figure when the api answers", async () => {
    const repo = makeScenario();
    const config = loadConfig({
      root: repo,
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_MONTHLY_CAP: "10",
        DELTA_PEACOCK_COST_SPEND_SOURCE: "aws-cost-explorer",
      },
    });
    const decision = await checkCostGuard(config, { system: "s", user: "u" }, new Date(), {
      costExplorerSend: () =>
        Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: "12.34" } } }] }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.monthToDate).toBeCloseTo(12.34);
  });

  it("ignores non-numeric entries in the counter file", () => {
    const counter = counterFile();
    writeFileSync(counter, JSON.stringify({ "2026-07": "not a number", "2026-06": 1.5 }));
    expect(readMonthSpend(counter, "2026-07")).toBe(0);
    expect(readMonthSpend(counter, "2026-06")).toBeCloseTo(1.5);
  });

  it("counts union ensembles without a judge call", async () => {
    const repo = makeScenario();
    const decision = await checkCostGuard(
      loadConfig({
        root: repo,
        env: {
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
          DELTA_PEACOCK_ENSEMBLE_ENABLED: "true",
          DELTA_PEACOCK_ENSEMBLE_MEMBERS: JSON.stringify([
            { provider: "anthropic", id: "a" },
            { provider: "anthropic", id: "b" },
          ]),
        },
      }),
      { system: "s", user: "u" },
      new Date(),
    );
    const single = await checkCostGuard(
      loadConfig({
        root: repo,
        env: {
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        },
      }),
      { system: "s", user: "u" },
      new Date(),
    );
    expect(decision.estimated).toBeCloseTo(single.estimated * 2);
  });

  it("treats missing totals in the response as zero", async () => {
    const total = await costExplorerMonthToDate(new Date(Date.UTC(2026, 6, 15)), () =>
      Promise.resolve({ ResultsByTime: [{}, { Total: { UnblendedCost: {} } }] }),
    );
    expect(total).toBe(0);
  });

  it("falls back to the counter with a warning when the api fails", async () => {
    const repo = makeScenario();
    const counter = counterFile();
    const config = loadConfig({
      root: repo,
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_MONTHLY_CAP: "100",
        DELTA_PEACOCK_COST_SPEND_SOURCE: "aws-cost-explorer",
        DELTA_PEACOCK_COST_COUNTER_PATH: counter,
      },
    });
    const decision = await checkCostGuard(config, { system: "s", user: "u" }, new Date(), {
      costExplorerSend: () => Promise.reject(new Error("no credentials")),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.notices.join("\n")).toContain("cost explorer unavailable");
    expect(decision.monthToDate).toBe(0); // fell back to the empty counter
  });
});
