import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import type { Guideline } from "../src/domain/guideline.js";
import type { Severity } from "../src/domain/severity.js";
import type { ModelPort } from "../src/model/port.js";
import { parseReviewResponse, quotesGuideline, type ParseOptions } from "../src/review/parse.js";
import { renderReview } from "../src/review/render.js";
import { buildReport } from "../src/review/report.js";
import { capReason } from "../src/review/run-review.js";
import { NOT_REVIEWED, statusLine } from "../src/scm/comment-format.js";
import { publishReview } from "../src/scm/publish.js";
import type { ScmPort } from "../src/scm/port.js";
import { renderStats, summarize, type StatsRecord } from "../src/stats/record.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE: Guideline = {
  id: "no-console",
  severity: "MAJOR",
  title: "No console statements",
  body: "Use the logger instead of console.log for all output.",
  sourcePath: "guidelines/no-console.md",
  languages: [],
  paths: [],
  tags: [],
};

describe("quotesGuideline", () => {
  it("accepts a verbatim passage of the body", () => {
    expect(
      quotesGuideline("Use the logger instead of console.log for all output.", GUIDELINE),
    ).toBe(true);
  });

  it("accepts the title verbatim", () => {
    expect(quotesGuideline("No console statements", GUIDELINE)).toBe(true);
  });

  it("accepts whitespace differences from the source text", () => {
    expect(quotesGuideline("Use   the logger\ninstead of console.log", GUIDELINE)).toBe(true);
  });

  it("accepts the same passage wrapped in markdown emphasis", () => {
    expect(quotesGuideline("**Use the logger** instead of `console.log`", GUIDELINE)).toBe(true);
  });

  it("accepts the same passage wrapped in quotation marks", () => {
    expect(quotesGuideline('"Use the logger instead of console.log"', GUIDELINE)).toBe(true);
  });

  it("rejects a paraphrase the guideline never says", () => {
    expect(quotesGuideline("not semicolons", GUIDELINE)).toBe(false);
  });

  it("rejects a real but too-short passage", () => {
    // "logger" is a genuine substring of the body, but under the 12 char minimum
    expect(quotesGuideline("logger", GUIDELINE)).toBe(false);
  });

  it("rejects a missing quote", () => {
    expect(quotesGuideline(undefined, GUIDELINE)).toBe(false);
  });
});

function options(): ParseOptions {
  return {
    guidelinesById: new Map([[GUIDELINE.id, GUIDELINE]]),
    generalPass: false,
    observationSeverityCap: "MINOR",
  };
}

describe("parseReviewResponse drops a misquoted violation", () => {
  it("drops it with reason misquoted and counts droppedMisquoted", () => {
    const text = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "a.js",
          line: 1,
          title: "t",
          body: "b",
          guidelineQuote: "always use var for everything",
        },
      ],
    });
    const parsed = parseReviewResponse(text, options());
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.droppedMisquoted).toBe(1);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]).toMatchObject({ reason: "misquoted", guidelineId: "no-console" });
  });

  it("keeps a violation whose guidelineQuote genuinely matches", () => {
    const text = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "a.js",
          line: 1,
          title: "t",
          body: "b",
          guidelineQuote: "Use the logger instead of console.log for all output.",
        },
      ],
    });
    const parsed = parseReviewResponse(text, options());
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.droppedMisquoted).toBe(0);
  });
});

describe("stats summary and render of misquoted", () => {
  it("carries errors.misquoted through summarize and renderStats", () => {
    const records: StatsRecord[] = [
      {
        at: "t",
        author: "Ada",
        addedLines: 10,
        bySeverity: {},
        byGuideline: {},
        errors: { misquoted: 2 },
      },
    ];
    const summaries = summarize(records);
    expect(summaries[0]?.misquoted).toBe(2);
    expect(renderStats(summaries)).toContain(
      "reviewer errors: 2 finding(s) dropped for quoting a rule the guideline does not have",
    );
  });

  it("omits the errors line when nothing was misquoted", () => {
    const summaries = summarize([
      { at: "t", author: "Bo", addedLines: 1, bySeverity: {}, byGuideline: {} },
    ]);
    expect(renderStats(summaries)).not.toContain("reviewer errors");
  });
});

describe("renderReview misquoted notice", () => {
  const gate = { threshold: "none", failing: 0, failed: false } as const;

  it("renders a notice when droppedMisquoted is greater than zero", () => {
    const text = renderReview({
      violations: [],
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      droppedMisquoted: 2,
      filtered: 0,
      gate,
    });
    expect(text).toContain("2 finding(s) dropped: the quoted rule is not in the cited guideline");
  });

  it("stays silent when nothing was misquoted", () => {
    const text = renderReview({
      violations: [],
      observations: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      droppedMisquoted: 0,
      filtered: 0,
      gate,
    });
    expect(text).not.toContain("quoted rule");
  });
});

describe("buildReport droppedMisquotedFindings", () => {
  const gate = { threshold: "none", failing: 0, failed: false } as const;

  it("is present only when misquoted findings were dropped", () => {
    const withDrops = buildReport({
      findings: [],
      filtered: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      droppedMisquoted: 3,
      gate,
    });
    expect(withDrops.droppedMisquotedFindings).toBe(3);

    const withoutDrops = buildReport({
      findings: [],
      filtered: [],
      proposals: [],
      droppedUncited: 0,
      adjustedLines: 0,
      droppedMisquoted: 0,
      gate,
    });
    expect("droppedMisquotedFindings" in withoutDrops).toBe(false);
  });
});

describe("statusLine", () => {
  const violation = (severity: Severity): Finding => ({
    kind: "violation",
    guidelineId: "no-console",
    severity,
    file: "a.js",
    line: 1,
    title: "t",
    body: "b",
  });

  it("clean run with a known changed-file count", () => {
    expect(statusLine({ findings: [], changedFiles: 1 })).toBe(
      "Passed. No findings in 1 changed file.",
    );
    expect(statusLine({ findings: [], changedFiles: 4 })).toBe(
      "Passed. No findings in 4 changed files.",
    );
  });

  it("clean run with an unknown changed-file count", () => {
    expect(statusLine({ findings: [] })).toBe("Passed. No findings in this change.");
  });

  it("findings: counts findings at MAJOR or above", () => {
    expect(
      statusLine({ findings: [violation("MAJOR"), violation("MINOR"), violation("BLOCKER")] }),
    ).toBe("3 findings, 2 major. See the comments.");
    expect(statusLine({ findings: [violation("MAJOR")] })).toBe(
      "1 finding, 1 major. See the comments.",
    );
  });

  it("nothing in scope or no guideline applies", () => {
    expect(
      statusLine({
        findings: [],
        outcome: { kind: "not-reviewed", line: NOT_REVIEWED.nothingInScope },
      }),
    ).toBe("Passed. No reviewable files in this change.");
    expect(
      statusLine({ findings: [], outcome: { kind: "not-reviewed", line: NOT_REVIEWED.noneApply } }),
    ).toBe("Passed. No reviewable files in this change.");
  });

  it("no guidelines at all", () => {
    expect(
      statusLine({
        findings: [],
        outcome: { kind: "not-reviewed", line: NOT_REVIEWED.noGuidelines },
      }),
    ).toBe("Passed. No guidelines to review against.");
  });

  it("change too large", () => {
    expect(
      statusLine({ findings: [], outcome: { kind: "not-reviewed", line: NOT_REVIEWED.tooLarge } }),
    ).toBe("Skipped. The change is too large to review.");
  });

  it("failed run", () => {
    expect(
      statusLine({ findings: [], outcome: { kind: "failed", reason: "the model call failed" } }),
    ).toBe("Failed. The review could not complete: the model call failed.");
  });

  it("clips a long failure reason to 140 characters", () => {
    const longReason = "x".repeat(200);
    const description = statusLine({
      findings: [],
      outcome: { kind: "failed", reason: longReason },
    });
    expect(description.length).toBe(140);
    expect(description.endsWith("...")).toBe(true);
    expect(description.startsWith("Failed. The review could not complete: ")).toBe(true);
  });

  it("cost cap skip", () => {
    expect(
      statusLine({
        findings: [],
        outcome: { kind: "capped", reason: "this change would cost more than the per review cap" },
      }),
    ).toBe("Skipped. this change would cost more than the per review cap.");
  });
});

/** A minimal in-memory ScmPort, so publishReview can be driven without an http fake. */
function fakePort(): {
  port: ScmPort;
  statuses: { state: string; description: string; name?: string }[];
  summaries: { id: string; body: string }[];
  inlineCalls: string[];
} {
  const statuses: { state: string; description: string; name?: string }[] = [];
  const summaries: { id: string; body: string }[] = [];
  const inlineCalls: string[] = [];
  let nextId = 1;
  const port: ScmPort = {
    listInlineComments: () => {
      inlineCalls.push("list");
      return Promise.resolve([]);
    },
    createInlineComment: () => {
      inlineCalls.push("create");
      return Promise.resolve();
    },
    updateComment: () => {
      inlineCalls.push("update");
      return Promise.resolve();
    },
    deleteComment: () => {
      inlineCalls.push("delete");
      return Promise.resolve();
    },
    listSummaryComments: () => Promise.resolve(summaries.map((s) => ({ id: s.id, body: s.body }))),
    createSummaryComment: (body) => {
      summaries.push({ id: String(nextId), body });
      nextId += 1;
      return Promise.resolve();
    },
    updateSummaryComment: (id, body) => {
      const summary = summaries.find((s) => s.id === id);
      if (summary !== undefined) summary.body = body;
      return Promise.resolve();
    },
    postStatus: (state, description, name) => {
      statuses.push({ state, description, ...(name !== undefined ? { name } : {}) });
      return Promise.resolve();
    },
  };
  return { port, statuses, summaries, inlineCalls };
}

describe("publishReview with outcome capped", () => {
  it("fails the status when failOn is MAJOR, posts no inline reconciliation, posts the summary", async () => {
    const { port, statuses, summaries, inlineCalls } = fakePort();
    await publishReview(port, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "MAJOR"),
      outcome: { kind: "capped", reason: "this change would cost more than the per review cap" },
      commitStatus: true,
      dryRun: false,
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.state).toBe("failure");
    expect(statuses[0]?.description).toBe(
      "Skipped. this change would cost more than the per review cap.",
    );
    expect(inlineCalls).toHaveLength(0); // a capped run knows nothing about the code
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toContain("The review was skipped:");
  });

  it("succeeds the status when the gate is advisory (failOn none)", async () => {
    const { port, statuses } = fakePort();
    await publishReview(port, {
      findings: [],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: evaluateGate([], "none"),
      outcome: { kind: "capped", reason: "the monthly cost cap is reached" },
      commitStatus: true,
      dryRun: false,
    });
    expect(statuses[0]?.state).toBe("success");
    expect(statuses[0]?.description).toBe("Skipped. the monthly cost cap is reached.");
  });
});

describe("capReason", () => {
  it("names the monthly cap when a monthlyCap reason is present", () => {
    expect(
      capReason(["month-to-date 1.0000 USD plus the estimate exceeds cost.monthlyCap 1.0000 USD"]),
    ).toBe("the monthly cost cap is reached");
  });

  it("names the per-review cap otherwise", () => {
    expect(capReason(["estimated cost 1.0000 USD exceeds cost.maxPerReview 1.0000 USD"])).toBe(
      "this change would cost more than the per review cap",
    );
  });
});

describe("an end-to-end review blocked by cost.maxPerReview", () => {
  const GUIDELINE_MD =
    "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
  const CITED = JSON.stringify({
    findings: [
      {
        guidelineId: "no-console",
        file: "src/app.js",
        line: 1,
        title: "t",
        body: "b",
        guidelineQuote: "Use the logger.",
      },
    ],
  });

  function makeScenario(): string {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE_MD);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "console.log('x');\n");
    commitAll(repo, "change");
    return repo;
  }

  it("posts the capped status through a fake SCM without calling the model", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      let requests = 0;
      const port: ModelPort = {
        complete() {
          requests += 1;
          return Promise.resolve({ text: CITED });
        },
      };
      const code = await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          GITHUB_TOKEN: "test-token",
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
          DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: port,
      });
      expect(code).toBe(0); // advisory: gate.failOn defaults to none
      expect(requests).toBe(0);
      expect(fake.statuses).toHaveLength(1);
      expect(fake.statuses[0]?.state).toBe("success");
      expect(fake.statuses[0]?.description).toBe(
        "Skipped. this change would cost more than the per review cap.",
      );
      expect(fake.issueComments[0]?.body).toContain("The review was skipped:");
    } finally {
      await fake.close();
    }
  });

  it("fails the status once a gate is configured", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      const code = await runCli(["review", "--fail-on", "MAJOR"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          GITHUB_TOKEN: "test-token",
          DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
          DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
          DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: { complete: () => Promise.resolve({ text: CITED }) },
      });
      expect(code).toBe(1);
      expect(fake.statuses[0]?.state).toBe("failure");
    } finally {
      await fake.close();
    }
  });
});
