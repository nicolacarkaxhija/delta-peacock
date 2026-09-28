import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import type { Finding } from "../src/domain/finding.js";
import type { Guideline } from "../src/domain/guideline.js";
import { runCli } from "../src/index.js";
import { buildJevPort } from "../src/model/build.js";
import { createJevPort, type JevPort } from "../src/model/jev.js";
import type { ModelPort } from "../src/model/port.js";
import { buildJevCalibrationRequest, calibrateWithJev } from "../src/review/calibrate.js";
import type { Candidate } from "../src/review/checks/detect.js";
import { runChecks, splitChecked } from "../src/review/checks/index.js";
import {
  decisionOf,
  guidelineSentences,
  jevJudgeRequest,
  settleWithJev,
} from "../src/review/checks/jev-judge.js";
import type { ReviewReport } from "../src/review/report.js";
import { jevCostOf } from "../src/review/run-review.js";
import { ledgerRecords } from "../src/stats/record.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const recorded = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, "fixtures", "jev", `${name}.json`), "utf8");

type Scripted = string | { status: number; body?: string; retryAfter?: string };

/** The real HTTP adapter over a fetch that plays recorded bodies back in order. */
function playback(...script: Scripted[]): { port: JevPort; calls: RequestInit[]; urls: string[] } {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  let tick = 0;
  const port = createJevPort({
    apiKey: "k-test",
    model: "jev-latest",
    baseUrl: "https://jev.test/",
    now: () => (tick += 50),
    sleep: () => Promise.resolve(),
    fetch: (url, init) => {
      urls.push(url as string);
      calls.push(init ?? {});
      const next = script[Math.min(calls.length - 1, script.length - 1)] ?? "";
      if (typeof next === "string") return Promise.resolve(new Response(next, { status: 200 }));
      const headers =
        next.retryAfter !== undefined ? { "retry-after": next.retryAfter } : undefined;
      return Promise.resolve(
        new Response(next.body ?? "{}", { status: next.status, ...(headers ? { headers } : {}) }),
      );
    },
  });
  return { port, calls, urls };
}

const PREFER: Guideline = {
  id: "prefer-test-ids",
  severity: "MINOR",
  title: "Test ids before roles, CSS selectors only as a last resort",
  body: [
    "Test ids outlast styling changes; CSS classes outlast nothing. Where a CSS selector is unavoidable, a comment next to it gives the reason.",
    "",
    "Good:",
    "",
    "```ts",
    "return this.testId('x'); // A CSS selector here, never quoted.",
    "```",
  ].join("\n"),
  sourcePath: "guidelines/prefer-test-ids.md",
  languages: [],
  paths: ["pages/**"],
  tags: [],
};

const RULE = "Where a CSS selector is unavoidable, a comment next to it gives the reason.";

const JUDGE = {
  question: "Does one of these comments say why?",
  comments: [{ line: 2, text: "Every image the carousel holds; it keeps every slide." }],
  fact: "`'img'` is a CSS selector.",
  fix: "Use getByTestId or getByRole.",
};

const JUDGED: Candidate = {
  guidelineId: "prefer-test-ids",
  check: "selectors",
  shape: "css",
  file: "pages/pdp.ts",
  line: 4,
  quote: "    return this.page.getByTestId('g').locator('img');",
  title: "CSS selector without a reason",
  body: "Literal body.",
  judge: JUDGE,
};

describe("the Jev adapter", () => {
  it("posts the documented request and reads the typed answers back", async () => {
    const { port, calls, urls } = playback(recorded("judge-keep"));
    const reply = await port.decide({ state: "s", questions: {} });
    expect(urls).toEqual(["https://jev.test/v1/systemone"]);
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k-test");
    expect(JSON.parse(calls[0]?.body as string)).toEqual({
      model: "jev-latest",
      state: "s",
      questions: {},
    });
    expect(reply.model).toBe("jev-1.13.0");
    expect(reply.answers["verdict"]?.confidence).toBe(0.86);
    expect(reply.usage).toEqual({ inputTokens: 612, outputTokens: 41 });
    expect(reply.latencyMs).toBe(50);
    expect(port.model).toBe("jev-latest");
  });

  it("backs off on 429 and 529, then fails on the last attempt or any other status", async () => {
    const { port, calls } = playback(
      { status: 429, retryAfter: "1" },
      { status: 529 },
      recorded("judge-keep"),
    );
    expect((await port.decide({ state: "s", questions: {} })).model).toBe("jev-1.13.0");
    expect(calls).toHaveLength(3);
    await expect(
      playback({ status: 529, body: "busy" }).port.decide({ state: "s", questions: {} }),
    ).rejects.toThrow("jev answered 529: busy");
    await expect(
      playback({ status: 401, body: "no key" }).port.decide({ state: "s", questions: {} }),
    ).rejects.toThrow("jev answered 401");
    await expect(
      playback('{"answers": 1}').port.decide({ state: "s", questions: {} }),
    ).rejects.toThrow("documented shape");
  });

  it("runs on the default endpoint and clock", () => {
    const port = createJevPort({ apiKey: "k", model: "jev-1.13.0" });
    expect(port.model).toBe("jev-1.13.0");
  });
});

describe("choosing the judge", () => {
  const config = (judge: Record<string, unknown>) =>
    ConfigSchema.parse({ model: { provider: "bedrock", id: "haiku" }, judge });

  it("keeps the model judge by default and says once when the key is missing", () => {
    const lines: string[] = [];
    expect(config({}).judge).toEqual({
      provider: "model",
      model: "jev-latest",
      minConfidence: 0.7,
    });
    expect(
      buildJevPort(config({}), { JEV_API_KEY: "k" }, (line) => lines.push(line)),
    ).toBeUndefined();
    expect(
      buildJevPort(config({ provider: "jev" }), {}, (line) => lines.push(line)),
    ).toBeUndefined();
    expect(lines).toEqual([
      "judge: judge.provider is jev but JEV_API_KEY is not set; the bedrock model judges instead",
    ]);
  });

  it("builds Jev when the key is present, or takes the injected port", () => {
    const withKey = buildJevPort(
      config({ provider: "jev", model: "jev-1.13.0", baseUrl: "https://jev.test" }),
      { JEV_API_KEY: "k" },
      () => undefined,
    );
    expect(withKey?.model).toBe("jev-1.13.0");
    const injected = playback().port;
    expect(buildJevPort(config({ provider: "jev" }), {}, () => undefined, injected)).toBe(injected);
    expect(
      buildJevPort(config({ provider: "jev" }), { JEV_API_KEY: "k" }, () => undefined)?.model,
    ).toBe("jev-latest");
  });

  it("prices Jev at its documented rate unless cost.rates names the model", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500 };
    expect(jevCostOf(config({ provider: "jev" }), usage)).toBeCloseTo(0.042);
    const priced = ConfigSchema.parse({
      judge: { provider: "jev" },
      cost: { rates: { "jev-latest": { rateInputPer1M: 0.1 } } },
    });
    expect(jevCostOf(priced, usage)).toBeCloseTo(0.1);
  });
});

describe("the Jev judge", () => {
  it("offers the guideline's prose sentences, the rule first, never the example code", () => {
    const sentences = guidelineSentences(PREFER, RULE);
    expect(sentences[0]).toBe(RULE);
    expect(sentences).toContain("Test ids outlast styling changes; CSS classes outlast nothing.");
    expect(sentences.join(" ")).not.toContain("never quoted");
    expect(sentences).not.toContain("Good:");
  });

  it("asks the comment question only when a comment is listed", () => {
    const sentences = guidelineSentences(PREFER, RULE);
    const request = jevJudgeRequest(JUDGED, PREFER, ">> 4| code", sentences);
    expect(Object.keys(request.questions)).toEqual(["verdict", "quote", "comment"]);
    expect(request.questions["comment"]?.criteria).toMatchObject({
      none: "No listed comment settles it.",
      c0: "Every image the carousel holds; it keeps every slide.",
    });
    expect(request.questions["quote"]?.criteria["s0"]).toBe(RULE);
    const bare: Candidate = { ...JUDGED, judge: { ...JUDGE, comments: [] } };
    expect(Object.keys(jevJudgeRequest(bare, PREFER, "", sentences).questions)).toEqual([
      "verdict",
      "quote",
    ]);
    const unjudged: Candidate = { ...JUDGED };
    delete unjudged.judge;
    const plain = jevJudgeRequest(unjudged, PREFER, "", sentences);
    expect(plain.questions["verdict"]?.instructions).toMatchObject({ question: "" });
  });

  it("reads a typed decision from the recorded answers", async () => {
    const sentences = guidelineSentences(PREFER, RULE);
    const reply = await playback(recorded("judge-drop")).port.decide({ state: "", questions: {} });
    expect(decisionOf(reply, sentences, JUDGE.comments)).toEqual({
      keep: false,
      confidence: 0.9,
      quotedSentence: RULE,
      comment: "Every image the carousel holds; it keeps every slide.",
    });
    const keep = await playback(recorded("judge-keep")).port.decide({ state: "", questions: {} });
    expect(decisionOf(keep, sentences, [])).toEqual({
      keep: true,
      confidence: 0.86,
      quotedSentence: RULE,
    });
  });

  it("confirms a kept candidate and traces provider, latency and confidence", async () => {
    const outcome = await settleWithJev(
      playback(recorded("judge-keep")).port,
      JUDGED,
      PREFER,
      "x",
      0.7,
    );
    expect(outcome.outcome).toBe("finding");
    expect(outcome.finding).toMatchObject({
      guidelineQuote: RULE,
      confidence: 0.86,
      judgedBy: { provider: "jev", latencyMs: 50, confidence: 0.86 },
    });
    expect(outcome.jevUsage).toEqual({ inputTokens: 612, outputTokens: 41 });
    expect(outcome.notice).toBe(
      "check: pages/pdp.ts:4 prefer-test-ids css: finding, confirmed by the judge (jev) at 0.86",
    );
  });

  it("drops and logs a verdict under the confidence floor", async () => {
    const outcome = await settleWithJev(
      playback(recorded("judge-unsure")).port,
      JUDGED,
      PREFER,
      "x",
      0.7,
    );
    expect(outcome.outcome).toBe("dropped");
    expect(outcome.rejected?.reason).toBe("judge-low-confidence");
    expect(JSON.parse(outcome.rejected?.raw ?? "{}")).toMatchObject({
      keep: true,
      confidence: 0.4,
    });
    expect(outcome.notice).toBe(
      "check: pages/pdp.ts:4 prefer-test-ids css: dropped, the judge (jev) is 0.40 sure, under judge.minConfidence 0.7",
    );
    const lenient = await settleWithJev(
      playback(recorded("judge-unsure")).port,
      JUDGED,
      PREFER,
      "x",
      0.3,
    );
    expect(lenient.outcome).toBe("finding");
  });

  it("drops only on a listed comment and a guideline sentence", async () => {
    const dropped = await settleWithJev(
      playback(recorded("judge-drop")).port,
      JUDGED,
      PREFER,
      "x",
      0.7,
    );
    expect(dropped.outcome).toBe("dropped");
    expect(dropped.rejected?.reason).toBe("judge-drop");
    expect(dropped.notice).toContain('the judge (jev) cites "Every image the carousel holds');
    const noComment = recorded("judge-drop").replace('"choice": "c0"', '"choice": "none"');
    const kept = await settleWithJev(playback(noComment).port, JUDGED, PREFER, "x", 0.7);
    expect(kept.outcome).toBe("finding");
    expect(kept.finding?.confidence).toBe(1);
    expect(kept.notice).toContain("drop cites no listed comment");
  });

  it("retries a failed call once, then records no finding", async () => {
    const recovered = await settleWithJev(
      playback({ status: 500 }, recorded("judge-keep")).port,
      JUDGED,
      PREFER,
      "x",
      0.7,
    );
    expect(recovered.outcome).toBe("finding");
    const missing = JSON.stringify({
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const failed = await settleWithJev(playback(missing).port, JUDGED, PREFER, "x", 0.7);
    expect(failed.outcome).toBe("failed");
    expect(failed.rejected?.reason).toBe("judge-failed");
    expect(failed.notice).toContain("judge (jev) failed twice (jev left a question unanswered)");
  });
});

describe("the checks on Jev", () => {
  const FILE = [
    "export class PdpPage {",
    "  /** Every image the carousel holds; it keeps every slide. */",
    "  images(): Locator {",
    "    return this.page.getByTestId('g').locator('img');",
    "  }",
    "  bare(): Locator {",
    "    return this.page.locator('.bare');",
    "  }",
    "}",
  ].join("\n");
  const DIFF = [
    "diff --git a/pages/pdp.ts b/pages/pdp.ts",
    "--- a/pages/pdp.ts",
    "+++ b/pages/pdp.ts",
    "@@ -0,0 +1,9 @@",
    ...FILE.split("\n").map((line) => `+${line}`),
    "",
  ].join("\n");

  it("never builds the model port and sums Jev's time, tokens and floor drops", async () => {
    const { bound } = splitChecked([PREFER], { "prefer-test-ids": "selectors" });
    const outcome = await runChecks({
      bound,
      diff: DIFF,
      read: (file) => (file === "pages/pdp.ts" ? FILE : undefined),
      files: () => [],
      configFiles: [],
      port: () => {
        throw new Error("the model judge is not asked");
      },
      redact: (text) => text,
      jev: playback(recorded("judge-unsure")).port,
      minConfidence: 0.7,
    });
    expect(outcome.tally).toEqual({ candidates: 2, findings: 1, dropped: 1, judgeFailed: 0 });
    expect(outcome.judge).toEqual({ provider: "jev", calls: 1, latencyMs: 50, lowConfidence: 1 });
    expect(outcome.jevUsage).toEqual({ inputTokens: 540, outputTokens: 30 });
    expect(outcome.usage).toBeUndefined();
  });

  it("defaults the floor to 0.7 when the caller names none", async () => {
    const { bound } = splitChecked([PREFER], { "prefer-test-ids": "selectors" });
    const outcome = await runChecks({
      bound,
      diff: DIFF,
      read: (file) => (file === "pages/pdp.ts" ? FILE : undefined),
      files: () => [],
      configFiles: [],
      port: () => {
        throw new Error("unused");
      },
      redact: (text) => text,
      jev: playback(recorded("judge-unsure")).port,
    });
    expect(outcome.judge?.lowConfidence).toBe(1);
  });
});

describe("calibration on Jev", () => {
  const finding = (line: number): Finding => ({
    kind: "violation",
    guidelineId: "g",
    severity: "MINOR",
    file: "a.ts",
    line,
    title: "t",
    body: "b",
  });

  it("asks one choice per finding over the diff", () => {
    const request = buildJevCalibrationRequest([finding(1)], "the diff");
    expect(request.state).toBe("the diff");
    expect(request.questions["f0"]?.criteria).toHaveProperty("demote");
  });

  it("annotates confident drops and demotions, never below the floor", async () => {
    const outcome = await calibrateWithJev(
      playback(recorded("calibration")).port,
      [finding(1), finding(2), finding(3), finding(4)],
      "diff",
      0.7,
    );
    expect(outcome.findings.map((one) => one.calibration)).toEqual([
      undefined,
      { action: "drop", reason: "jev drop at confidence 0.85" },
      undefined,
      undefined,
    ]);
    expect(outcome.jevUsage).toEqual({ inputTokens: 1804, outputTokens: 52 });
    expect(await calibrateWithJev(playback().port, [], "diff", 0.7)).toEqual({
      findings: [],
      notices: [],
    });
    const failed = await calibrateWithJev(
      playback({ status: 422, body: "bad" }).port,
      [finding(1)],
      "d",
      0.7,
    );
    expect(failed.notices[0]).toContain("calibration failed (jev answered 422: bad)");
    expect(failed.findings).toHaveLength(1);
  });
});

describe("the ledger on Jev", () => {
  it("records the judge per review and per finding", () => {
    const records = ledgerRecords({
      at: "t",
      author: "a",
      addedLines: 3,
      findings: [
        {
          kind: "violation",
          guidelineId: "g",
          severity: "MINOR",
          file: "a.ts",
          line: 1,
          title: "t",
          body: "b",
          judgedBy: { provider: "jev", latencyMs: 90, confidence: 0.8 },
        },
      ],
      misquoted: 0,
      judge: { provider: "jev", calls: 1, latencyMs: 90, lowConfidence: 0, cost: 0.00002 },
      attribution: {},
    });
    expect(records[0]).toMatchObject({ judge: { provider: "jev", calls: 1, latencyMs: 90 } });
    expect(records[1]).toMatchObject({
      judge: { provider: "jev", latencyMs: 90, confidence: 0.8 },
    });
  });
});

describe("a review with the Jev judge", () => {
  const GUIDELINE = `---
id: prefer-test-ids
severity: MINOR
paths: ['pages/**']
---
# Test ids before roles, CSS selectors only as a last resort

Where a CSS selector is unavoidable, a comment next to it gives the reason.
`;
  const config = (extra: string) => `review:
  target: main
  fetchTarget: false
  checks:
    prefer-test-ids: selectors
stats:
  enabled: true
cost:
  rateInputPer1M: 1
  rateOutputPer1M: 5
judge:
  provider: jev
${extra}`;
  const PAGE = [
    "export class PlpPage {",
    "  /** The listing's banner. */",
    "  banner(): Locator {",
    "    return this.page.locator('.banner');",
    "  }",
    "}",
    "",
  ].join("\n");

  function repoWith(extra = ""): string {
    const repo = makeRepo();
    write(repo, "guidelines/prefer-test-ids.md", GUIDELINE);
    write(repo, "delta-peacock.config.yaml", config(extra));
    commitAll(repo, "guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "pages/plp.ts", PAGE);
    commitAll(repo, "change");
    return repo;
  }

  const modelJudge = (): { port: ModelPort; calls: number[] } => {
    const calls: number[] = [];
    return {
      calls,
      port: {
        complete() {
          calls.push(1);
          return Promise.resolve({
            text: JSON.stringify({ verdict: "confirm", guidelineQuote: RULE }),
            usage: { inputTokens: 100, outputTokens: 20 },
          });
        },
      },
    };
  };

  async function review(repo: string, jevPort?: JevPort) {
    let err = "";
    const model = modelJudge();
    const code = await runCli(["review", "--report", "review.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      modelPort: model.port,
      ...(jevPort !== undefined ? { jevPort } : {}),
    });
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    const ledger = readFileSync(path.join(repo, "delta-peacock.stats.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, err, report, ledger, modelCalls: model.calls.length };
  }

  it("says once that the key is missing and lets the model judge", async () => {
    const { err, report, ledger, modelCalls } = await review(repoWith());
    expect(err.match(/JEV_API_KEY is not set/g)).toHaveLength(1);
    expect(modelCalls).toBe(1);
    expect(report.judge).toMatchObject({ provider: "model", calls: 1, lowConfidence: 0 });
    expect(ledger.find((line) => line["kind"] === "finding")?.["judge"]).toMatchObject({
      provider: "model",
    });
  });

  it("judges on Jev, prices it and records it in the report and the ledger", async () => {
    const { err, report, ledger, modelCalls } = await review(
      repoWith(),
      playback(recorded("judge-keep")).port,
    );
    expect(modelCalls).toBe(0);
    expect(err).toContain("confirmed by the judge (jev) at 0.86");
    expect(err).toMatch(
      /judge: jev jev-latest, 1 call\(s\), 50 ms, 0 under judge.minConfidence, 0\.0000\d+ USD/,
    );
    expect(report.judge).toMatchObject({
      provider: "jev",
      calls: 1,
      usage: { inputTokens: 612, outputTokens: 41 },
    });
    expect(report.cost?.total).toBeCloseTo((612 / 1_000_000) * 0.042);
    const review0 = ledger.find((line) => line["kind"] === "review");
    expect(review0?.["judge"]).toMatchObject({ provider: "jev", calls: 1, latencyMs: 50 });
    expect(ledger.find((line) => line["kind"] === "finding")?.["judge"]).toEqual({
      provider: "jev",
      latencyMs: 50,
      confidence: 0.86,
    });
  });

  it("calibrates on Jev when calibration is on", async () => {
    const { err, report } = await review(
      repoWith("calibration:\n  enabled: true\n"),
      playback(recorded("judge-keep"), recorded("calibration")).port,
    );
    expect(err).not.toContain("calibration failed");
    expect(report.judge?.usage).toMatchObject({ inputTokens: 612 + 1804, outputTokens: 41 + 52 });
    expect(report.findings[0]?.calibration).toBeUndefined();
  });
});
