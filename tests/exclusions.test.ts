import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { spendCeiling } from "../src/cost/ceiling.js";
import type { Finding } from "../src/domain/finding.js";
import type { Guideline } from "../src/domain/guideline.js";
import { parseGuidelineContent } from "../src/guidelines/loader.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { applyExclusions } from "../src/review/exclusions.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const EXCLUSION = "A value the function receives as a parameter is never a finding.";

const GUARD = `---
id: guard-before-use
severity: MAJOR
exclusions:
  - ${EXCLUSION}
---
# Guard a value before use

Check a value for null before reading a property of it. ${EXCLUSION}
`;

function guideline(content: string): Guideline {
  const parsed = parseGuidelineContent(content, "guidelines/guard.md");
  if (!("guideline" in parsed)) throw new Error(JSON.stringify(parsed));
  return parsed.guideline;
}

function problem(content: string): string {
  const parsed = parseGuidelineContent(content, "guidelines/guard.md");
  return "problem" in parsed ? parsed.problem : "";
}

const FINDING: Finding = {
  kind: "violation",
  guidelineId: "guard-before-use",
  severity: "MAJOR",
  file: "src/app.js",
  line: 2,
  title: "Read before a null check",
  body: "name is read without a guard.",
};

/** A port that answers every request with the next reply, and keeps what it was asked. */
function scripted(...replies: string[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const text = replies[Math.min(requests.length - 1, replies.length - 1)] ?? "";
        return Promise.resolve({ text, usage: { inputTokens: 100, outputTokens: 10 } });
      },
    },
  };
}

const verdict = (value: object): string => JSON.stringify(value);

const ZERO = {
  rateInputPer1M: 0,
  rateOutputPer1M: 0,
  rateCacheReadPer1M: 0,
  rateCacheWritePer1M: 0,
};

function options(port: ModelPort, rule: Guideline = guideline(GUARD)) {
  return {
    port: () => port,
    guidelinesById: new Map([[rule.id, rule]]),
    linesOf: () => ["function greet(name) {", "  return name.length;", "}"],
    concurrency: 2,
  };
}

describe("exclusions in the guideline frontmatter", () => {
  it("reads the sentences the guideline says", () => {
    expect(guideline(GUARD).exclusions).toEqual([EXCLUSION]);
  });

  it("refuses a sentence the guideline does not say word for word", () => {
    const changed = GUARD.replace(`  - ${EXCLUSION}`, "  - A constant is never a finding here.");
    expect(problem(changed)).toContain("must be a sentence the guideline says word for word");
  });

  it("refuses anything but a list of sentences", () => {
    expect(problem(GUARD.replace(`  - ${EXCLUSION}`, "  - 3"))).toContain(
      "must be a list of sentences",
    );
  });
});

describe("the exclusion check", () => {
  it("drops a finding the verdict excludes by naming a listed sentence", async () => {
    const { port, requests } = scripted(
      verdict({ exclusion: EXCLUSION, reason: "name is a parameter" }),
    );
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([]);
    expect(outcome.dropped[0]).toMatchObject({
      reason: "excluded",
      guidelineId: "guard-before-use",
    });
    expect(requests[0]?.user).toContain(`- ${EXCLUSION}`);
    expect(requests[0]?.user).toContain("<line>\n  return name.length;\n</line>");
    expect(requests[0]?.user).toContain(">>   2|   return name.length;");
    expect(outcome.usage?.inputTokens).toBe(100);
  });

  it("asks at temperature 0 for the listed sentence or none", async () => {
    const { port, requests } = scripted(verdict({ exclusion: "none" }));
    await applyExclusions([FINDING], options(port));
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.system).toContain(
      '{"exclusion": "<one listed sentence, copied exactly, or none>"',
    );
  });

  it("reads a listed sentence despite quotes, a bullet and spacing", async () => {
    const loose = `- "${EXCLUSION.replace(" the ", "  the ")}"`;
    const { port } = scripted(verdict({ exclusion: loose }));
    expect((await applyExclusions([FINDING], options(port))).kept).toEqual([]);
  });

  it("keeps a finding the verdict answers none for", async () => {
    const { port } = scripted(verdict({ exclusion: "none", reason: "no listed case" }));
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.notices).toEqual([]);
  });

  it("reads a sentence the list does not hold as none and logs it", async () => {
    const { port } = scripted(verdict({ exclusion: "Template conditions are presentation." }));
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.notices).toEqual([
      'exclusions: src/app.js:2 guard-before-use: the verdict names a sentence the guideline does not list, read as none: "Template conditions are presentation."',
    ]);
  });

  it("decides one guideline and line text once per run, so a repeat cannot drift", async () => {
    const { port, requests } = scripted(
      verdict({ exclusion: EXCLUSION }),
      verdict({ exclusion: "none" }),
    );
    const again = { ...FINDING, file: "src/other.js" };
    const outcome = await applyExclusions([FINDING, again], options(port));
    expect(requests).toHaveLength(1);
    expect(outcome.dropped).toHaveLength(2);
    expect(outcome.usage?.inputTokens).toBe(100);
  });

  it("asks again for another line text", async () => {
    const { port, requests } = scripted(verdict({ exclusion: "none" }));
    const other = { ...FINDING, line: 1 };
    await applyExclusions([FINDING, other], options(port));
    expect(requests).toHaveLength(2);
  });

  it("asks once more after an unreadable reply, then keeps the finding", async () => {
    const { port, requests } = scripted("no json here");
    const outcome = await applyExclusions([FINDING], options(port));
    expect(requests).toHaveLength(2);
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.notices[0]).toContain("no verdict");
  });

  it("keeps the finding when the call fails", async () => {
    const port: ModelPort = { complete: () => Promise.reject(new Error("connection reset")) };
    const outcome = await applyExclusions([FINDING], options(port));
    expect(outcome.kept).toEqual([FINDING]);
    expect(outcome.notices[0]).toContain("connection reset");
  });

  it("makes no call for a guideline that lists no exclusions", async () => {
    const plain = guideline(GUARD.replace(`exclusions:\n  - ${EXCLUSION}\n`, ""));
    const { port, requests } = scripted("{}");
    const outcome = await applyExclusions([FINDING], options(port, plain));
    expect(requests).toHaveLength(0);
    expect(outcome.kept).toEqual([FINDING]);
  });
});

describe("a review with an excluded finding", () => {
  function repo(): string {
    const cwd = makeRepo();
    write(cwd, "guidelines/guard.md", GUARD);
    commitAll(cwd, "rules");
    git(cwd, "checkout", "-q", "-b", "feature");
    write(cwd, "src/app.js", "function greet(name) {\n  return name.length;\n}\n");
    commitAll(cwd, "change");
    return cwd;
  }

  const REVIEW = JSON.stringify({
    findings: [
      {
        guidelineId: "guard-before-use",
        file: "src/app.js",
        line: 2,
        quote: "  return name.length;",
        guidelineQuote: "Check a value for null before reading a property of it.",
        title: "Read before a null check",
        body: "name is read without a guard.",
      },
    ],
  });

  async function review(judged: string): Promise<{ code: number; report: ReviewReport }> {
    const cwd = repo();
    const port: ModelPort = {
      complete(request) {
        const text = request.system.includes("exclusion check") ? judged : REVIEW;
        return Promise.resolve({ text });
      },
    };
    const code = await runCli(["review", "--report", "r.json", "--fail-on", "MAJOR"], {
      cwd,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
    return { code, report };
  }

  it("posts nothing and passes the gate when the guideline excludes the line", async () => {
    const { code, report } = await review(verdict({ verdict: "excluded", exclusion: EXCLUSION }));
    expect(code).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.rejectedCandidates?.map((one) => one.reason)).toContain("excluded");
  });

  it("keeps the finding and gates when no listed case covers it", async () => {
    const { code, report } = await review(verdict({ exclusion: "none" }));
    expect(code).toBe(2);
    expect(report.findings).toHaveLength(1);
  });

  it("sends only the verdicts to exclusions.model and prices them at its own rates", async () => {
    const cwd = repo();
    const asked: { review: number; verdicts: number; refs: string[] } = {
      review: 0,
      verdicts: 0,
      refs: [],
    };
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const reviewer: ModelPort = {
      complete(request) {
        expect(request.system).not.toContain("exclusion check");
        asked.review += 1;
        return Promise.resolve({ text: REVIEW, usage });
      },
    };
    const judge: ModelPort = {
      complete(request) {
        expect(request.system).toContain("exclusion check");
        asked.verdicts += 1;
        return Promise.resolve({ text: verdict({ exclusion: "none" }), usage });
      },
    };
    const err: string[] = [];
    await runCli(["review", "--report", "r.json"], {
      cwd,
      env: {
        DELTA_PEACOCK_MODEL_ID: "small",
        DELTA_PEACOCK_EXCLUSIONS_MODEL: '{"provider":"bedrock","id":"large"}',
        DELTA_PEACOCK_COST_RATES: '{"small":{"rateInputPer1M":1},"large":{"rateInputPer1M":3}}',
        DELTA_PEACOCK_COST_COUNTER_PATH: path.join(cwd, "spend.json"),
      },
      out: () => undefined,
      err: (text) => err.push(text),
      modelPort: reviewer,
      modelPortFor: (ref) => {
        asked.refs.push(ref.id);
        return judge;
      },
    });
    const report = JSON.parse(readFileSync(path.join(cwd, "r.json"), "utf8")) as ReviewReport;
    expect(asked).toEqual({ review: 1, verdicts: 1, refs: ["large"] });
    expect(report.usage?.inputTokens).toBe(1_000_000);
    expect(report.cost?.total).toBe(1);
    expect(report.exclusionModel).toMatchObject({ id: "large", cost: { total: 3 } });
    expect(err.join("")).toMatch(
      /^cost: 1000000 tokens in, 0 out on small, verdicts 1000000 tokens in, 0 out on large, 4\.0000 USD;/m,
    );
  });
});

describe("the exclusions.model setting", () => {
  it("needs a base url for an openai-compatible host", () => {
    const parsed = ConfigSchema.safeParse({
      exclusions: { model: { provider: "openai-compatible", id: "local" } },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("exclusions.model.baseUrl");
  });

  it("prices a verdict at the rates of its own model under one ceiling", () => {
    const ceiling = spendCeiling(10, { ...ZERO, rateInputPer1M: 1 });
    ceiling.add({ inputTokens: 1_000_000, outputTokens: 0 }, { ...ZERO, rateInputPer1M: 3 });
    ceiling.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(ceiling.spent()).toBe(4);
  });
});
