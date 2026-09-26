import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { runCli } from "../src/index.js";
import type { Finding } from "../src/domain/finding.js";
import type { ModelPort } from "../src/model/port.js";
import { modelRates, ratesFor } from "../src/model/usage.js";
import { pullRequestAttribution } from "../src/review/run-review.js";
import type { ScmPort } from "../src/scm/port.js";
import {
  appendRecord,
  attributionOf,
  ledgerRecords,
  parseConventionalTitle,
  readFindings,
  readRecords,
  summarize,
} from "../src/stats/record.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const VIOLATION: Finding = {
  kind: "violation",
  guidelineId: "no-console",
  severity: "MAJOR",
  file: "src/app.js",
  line: 3,
  title: "Console",
  body: "b",
};
const OBSERVATION: Finding = {
  kind: "observation",
  severity: "MINOR",
  file: "src/util.js",
  line: 9,
  title: "Naming",
  body: "b",
};

describe("parseConventionalTitle", () => {
  it.each([
    ["feat(checkout): add gift cards", "feat", "checkout"],
    ["fix!: drop the old flag", "fix", ""],
    ["Feat( Api )!: breaking", "feat", "Api"],
    ["  chore(deps-dev): bump", "chore", "deps-dev"],
    ["chore(): empty scope", "chore", ""],
    ["Update the readme", "", ""],
    ["feat(checkout) missing colon", "", ""],
    ["", "", ""],
  ])("%j gives type %j and scope %j", (title, type, scope) => {
    expect(parseConventionalTitle(title)).toEqual({ type, scope });
  });
});

describe("attributionOf", () => {
  it("carries pr, title, scope and type", () => {
    expect(attributionOf({ number: 7, url: "https://x/pull/7" }, "fix(cart): y")).toEqual({
      pr: { number: 7, url: "https://x/pull/7" },
      title: "fix(cart): y",
      scope: "cart",
      type: "fix",
    });
  });

  it("leaves out an empty pr and a missing title, keeping empty scope and type", () => {
    expect(attributionOf({}, undefined)).toEqual({ scope: "", type: "" });
    expect(attributionOf(undefined, "plain")).toEqual({ title: "plain", scope: "", type: "" });
    expect(attributionOf({ url: "u" }, undefined)).toEqual({
      pr: { url: "u" },
      scope: "",
      type: "",
    });
  });
});

describe("ledgerRecords", () => {
  it("writes the review line, then one line per finding, all attributed", () => {
    const attribution = attributionOf({ number: 7 }, "feat(checkout): z");
    const records = ledgerRecords({
      at: "2026-09-26T10:00:00.000Z",
      author: "Ada",
      addedLines: 12,
      findings: [VIOLATION, OBSERVATION],
      misquoted: 1,
      attribution,
      model: "model-b",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
      cost: 0.25,
      durationMs: 1234,
    });
    expect(records).toEqual([
      {
        kind: "review",
        at: "2026-09-26T10:00:00.000Z",
        author: "Ada",
        addedLines: 12,
        bySeverity: { MAJOR: 1, MINOR: 1 },
        byGuideline: { "no-console": 1, "(observation)": 1 },
        errors: { misquoted: 1 },
        pr: { number: 7 },
        title: "feat(checkout): z",
        scope: "checkout",
        type: "feat",
        model: "model-b",
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
        cost: 0.25,
        durationMs: 1234,
      },
      {
        kind: "finding",
        at: "2026-09-26T10:00:00.000Z",
        author: "Ada",
        pr: { number: 7 },
        title: "feat(checkout): z",
        scope: "checkout",
        type: "feat",
        guideline: "no-console",
        severity: "MAJOR",
        file: "src/app.js",
        line: 3,
      },
      {
        kind: "finding",
        at: "2026-09-26T10:00:00.000Z",
        author: "Ada",
        pr: { number: 7 },
        title: "feat(checkout): z",
        scope: "checkout",
        type: "feat",
        guideline: "(observation)",
        severity: "MINOR",
        file: "src/util.js",
        line: 9,
      },
    ]);
  });

  it("leaves out model, tokens, cost and duration it was not given", () => {
    const [review] = ledgerRecords({
      at: "t",
      author: "Ada",
      addedLines: 0,
      findings: [],
      misquoted: 0,
      attribution: { scope: "", type: "" },
    });
    expect(review).toEqual({
      kind: "review",
      at: "t",
      author: "Ada",
      addedLines: 0,
      bySeverity: {},
      byGuideline: {},
      scope: "",
      type: "",
    });
  });
});

describe("reading a mixed ledger", () => {
  it("reads old and new review lines alike and the finding lines apart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-ledger-"));
    const old = {
      at: "2026-01-01T00:00:00.000Z",
      author: "Grace",
      addedLines: 4,
      bySeverity: { MAJOR: 1 },
      byGuideline: { "no-console": 1 },
    };
    writeFileSync(path.join(dir, "l.jsonl"), `${JSON.stringify(old)}\nnot json\n42\n`);
    await appendRecord(
      dir,
      "l.jsonl",
      ledgerRecords({
        at: "2026-09-26T00:00:00.000Z",
        author: "Ada",
        addedLines: 3,
        findings: [VIOLATION],
        misquoted: 0,
        attribution: attributionOf({ number: 7 }, "fix(cart): y"),
      }),
    );
    const reviews = [...readRecords(dir, "l.jsonl")];
    expect(reviews.map((record) => record.author)).toEqual(["Grace", "Ada"]);
    expect(reviews[0]?.scope).toBeUndefined();
    expect(reviews[1]?.scope).toBe("cart");
    const findings = [...readFindings(dir, "l.jsonl")];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      guideline: "no-console",
      scope: "cart",
      pr: { number: 7 },
    });
    expect(summarize(reviews).map((summary) => summary.findings)).toEqual([1, 1]);
    expect([...readFindings(dir, "missing.jsonl")]).toEqual([]);
  });
});

describe("per-model cost rates", () => {
  const flat = {
    rateInputPer1M: 1,
    rateOutputPer1M: 5,
    rateCacheReadPer1M: 0.1,
    rateCacheWritePer1M: 1.25,
  };

  it("prices a model from its own entry, an unpriced field as zero", () => {
    expect(ratesFor({ ...flat, rates: { "model-b": { rateInputPer1M: 3 } } }, "model-b")).toEqual({
      rateInputPer1M: 3,
      rateOutputPer1M: 0,
      rateCacheReadPer1M: 0,
      rateCacheWritePer1M: 0,
    });
  });

  it("falls back to the flat keys for an unlisted model, no model, or no map", () => {
    const withMap = { ...flat, rates: { "model-b": { rateInputPer1M: 3 } } };
    expect(ratesFor(withMap, "model-a")).toEqual(flat);
    expect(ratesFor(withMap, undefined)).toEqual(flat);
    expect(ratesFor(flat, "model-a")).toEqual(flat);
  });

  it("reads the map from config and follows the env model override", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-rates-"));
    writeFileSync(
      path.join(dir, "delta-peacock.config.yaml"),
      "model:\n  id: model-a\ncost:\n  rateInputPer1M: 1\n  rates:\n    model-b:\n      rateInputPer1M: 10\n      rateOutputPer1M: 50\n",
    );
    expect(modelRates(loadConfig({ root: dir })).rateInputPer1M).toBe(1);
    const overridden = loadConfig({ root: dir, env: { DELTA_PEACOCK_MODEL_ID: "model-b" } });
    expect(modelRates(overridden)).toMatchObject({ rateInputPer1M: 10, rateOutputPer1M: 50 });
    const fromEnv = loadConfig({
      root: dir,
      env: { DELTA_PEACOCK_COST_RATES: '{"model-a":{"rateInputPer1M":7}}' },
    });
    expect(modelRates(fromEnv).rateInputPer1M).toBe(7);
  });
});

describe("pullRequestAttribution", () => {
  function deps(scmPort?: ScmPort) {
    const errors: string[] = [];
    return {
      errors,
      err: (text: string) => {
        errors.push(text);
      },
      credentials: {},
      ...(scmPort !== undefined ? { scmPort } : {}),
    };
  }
  const github = (dir: string) =>
    loadConfig({
      root: dir,
      flags: { "scm.provider": "github", "scm.repository": "acme/widgets", "scm.pullRequest": "7" },
    });

  it("asks nothing of a local run", async () => {
    const config = loadConfig({ root: mkdtempSync(path.join(tmpdir(), "dp-attr-")) });
    const d = deps();
    expect(await pullRequestAttribution(d as never, config)).toEqual({ scope: "", type: "" });
  });

  it("takes number, url and title from the host", async () => {
    const port = {
      getPullRequestText: () =>
        Promise.resolve({ title: "refactor(search): split", body: "", url: "https://x/7" }),
    } as unknown as ScmPort;
    const config = github(mkdtempSync(path.join(tmpdir(), "dp-attr-")));
    expect(await pullRequestAttribution(deps(port) as never, config)).toEqual({
      pr: { number: 7, url: "https://x/7" },
      title: "refactor(search): split",
      scope: "search",
      type: "refactor",
    });
  });

  it("keeps the number when the host has no title call or fails", async () => {
    const config = github(mkdtempSync(path.join(tmpdir(), "dp-attr-")));
    expect(await pullRequestAttribution(deps({} as ScmPort) as never, config)).toEqual({
      pr: { number: 7 },
      scope: "",
      type: "",
    });
    const failing = {
      getPullRequestText: () => Promise.reject(new Error("401 bad token\nmore")),
    } as unknown as ScmPort;
    const d = deps(failing);
    expect(await pullRequestAttribution(d as never, config)).toEqual({
      pr: { number: 7 },
      scope: "",
      type: "",
    });
    expect(d.errors.join("")).toContain("pull request title unavailable (401 bad token)");
  });
});

describe("a review with stats on a pull request", () => {
  it("writes attributed review and finding lines with the model in use", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.prText.title = "feat(checkout): gift cards";
      const repo = makeRepo();
      write(
        repo,
        "guidelines/no-console.md",
        "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n",
      );
      commitAll(repo, "rules");
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "src/app.js", "console.log(1);\n");
      commitAll(repo, "change");
      const reply = JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 1,
            title: "One",
            body: "b",
            guidelineQuote: "Use the logger.",
          },
        ],
      });
      const port: ModelPort = {
        complete: () =>
          Promise.resolve({ text: reply, usage: { inputTokens: 1000, outputTokens: 100 } }),
      };
      let stderr = "";
      await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_STATS_ENABLED: "true",
          DELTA_PEACOCK_MODEL_ID: "model-b",
          DELTA_PEACOCK_COST_RATES: '{"model-b":{"rateInputPer1M":1,"rateOutputPer1M":5}}',
          DELTA_PEACOCK_COST_COUNTER_PATH: path.join(repo, ".spend.json"),
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_SCM_DRY_RUN: "true",
          GITHUB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: (text) => {
          stderr += text;
        },
        modelPort: port,
      });
      expect(stderr).toMatch(/^cost: 1000 tokens in, 100 out on model-b, 0\.0015 USD; /m);
      const lines = readFileSync(path.join(repo, "delta-peacock.stats.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      const attribution = {
        pr: { number: 7, url: "https://github.com/acme/widgets/pull/7" },
        title: "feat(checkout): gift cards",
        scope: "checkout",
        type: "feat",
      };
      expect(lines[0]).toMatchObject({
        kind: "review",
        ...attribution,
        model: "model-b",
        tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      });
      expect(lines[0]?.["cost"]).toBeCloseTo(0.0015);
      expect(typeof lines[0]?.["durationMs"]).toBe("number");
      expect(lines[1]).toMatchObject({
        kind: "finding",
        ...attribution,
        guideline: "no-console",
        severity: "MAJOR",
        file: "src/app.js",
        line: 1,
      });
    } finally {
      await fake.close();
    }
  });
});
