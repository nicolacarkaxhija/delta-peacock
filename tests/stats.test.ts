import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { renderCommentBody } from "../src/scm/publish.js";
import { readRecords, renderStats, summarize, type StatsRecord } from "../src/stats/record.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

const TWO = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 1,
      title: "One",
      body: "b",
      guidelineQuote: "Use the logger.",
    },
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      title: "Two",
      body: "b",
      guidelineQuote: "Use the logger.",
    },
  ],
});

function model(text: string): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

function reviewRepo(author = "Ada"): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log(1);\nconsole.log(2);\nconst c = 3;\n");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    `user.name=${author}`,
    "-c",
    "user.email=a@example.com",
    "commit",
    "-q",
    "-m",
    "change",
  );
  return repo;
}

async function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  port: ModelPort = model(TWO),
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    env,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    modelPort: port,
  });
  return { code, stdout, stderr };
}

describe("recording during review", () => {
  it("appends a record only when enabled, attributed to the commit author", async () => {
    const off = reviewRepo();
    await run(off, ["review"]);
    expect(existsSync(path.join(off, "delta-peacock.stats.jsonl"))).toBe(false);

    const on = reviewRepo("Grace");
    await run(on, ["review"], { DELTA_PEACOCK_STATS_ENABLED: "true" });
    const records = [...readRecords(on, "delta-peacock.stats.jsonl")];
    expect(records).toHaveLength(1);
    expect(records[0]?.author).toBe("Grace");
    expect(records[0]?.addedLines).toBe(3);
    expect(records[0]?.bySeverity.MAJOR).toBe(2);
    expect(records[0]?.byGuideline["no-console"]).toBe(2);
  });

  it("records what survived the gate, not baselined findings", async () => {
    const repo = reviewRepo();
    await run(repo, ["review", "--write-baseline"], { DELTA_PEACOCK_STATS_ENABLED: "true" });
    // the first run baselined both, so the second records zero findings
    await run(repo, ["review"], { DELTA_PEACOCK_STATS_ENABLED: "true" });
    const records = [...readRecords(repo, "delta-peacock.stats.jsonl")];
    expect(records).toHaveLength(2);
    expect(Object.keys(records[1]?.byGuideline ?? {})).toHaveLength(0);
  });
});

describe("the stats command", () => {
  it("renders per-contributor findings with normalized and raw numbers together", async () => {
    const repo = reviewRepo("Ada");
    await run(repo, ["review"], { DELTA_PEACOCK_STATS_ENABLED: "true" });
    const { code, stdout } = await run(repo, ["stats", "--report", "s.json"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Ada:");
    expect(stdout).toContain("2 finding(s) over 3 added line(s)");
    expect(stdout).toContain("per 100 lines"); // the normalized figure sits beside the raw
    expect(stdout).toContain("by guideline: no-console 2");
    const report = JSON.parse(readFileSync(path.join(repo, "s.json"), "utf8")) as {
      contributors: { author: string; per100Lines: number }[];
    };
    expect(report.contributors[0]?.author).toBe("Ada");
  });

  it("says so on an empty ledger", async () => {
    const { code, stdout } = await run(makeRepo(), ["stats"]);
    expect(code).toBe(0);
    expect(stdout).toContain("no stats recorded yet");
  });
});

describe("stats backfill", () => {
  function githubEnv(baseUrl: string): Record<string, string> {
    return {
      DELTA_PEACOCK_SCM_PROVIDER: "github",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      DELTA_PEACOCK_SCM_BASE_URL: baseUrl,
      GITHUB_TOKEN: "test-token",
    };
  }

  it("reconstructs a record from the reviewer's own marked comments", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.reviewComments.push(
        {
          id: 1,
          body: renderCommentBody(
            {
              kind: "violation",
              guidelineId: "no-console",
              severity: "MAJOR",
              file: "src/app.js",
              line: 3,
              title: "Console",
              body: "b",
            },
            "aaaa11112222",
          ),
        },
        { id: 2, body: "a human comment with no marker" },
      );
      const repo = makeRepo();
      const { code, stdout } = await run(repo, ["stats", "--backfill"], githubEnv(fake.baseUrl));
      expect(code).toBe(0);
      expect(stdout).toContain("backfilled 1 finding(s)");
      const records = [...readRecords(repo, "delta-peacock.stats.jsonl")];
      expect(records[0]?.author).toBe("octocat"); // the PR author, not a comment author
      expect(records[0]?.byGuideline["no-console"]).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("says so when the PR has no marked comments, and refuses local mode", async () => {
    const fake = await startFakeGitHub();
    try {
      const empty = await run(makeRepo(), ["stats", "--backfill"], githubEnv(fake.baseUrl));
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain("nothing to backfill");
    } finally {
      await fake.close();
    }
    const local = await run(makeRepo(), ["stats", "--backfill"]);
    expect(local.code).toBe(1);
    expect(local.stderr).toContain("local mode has none");
  });
});

describe("recordFromSignals and readRecords", () => {
  it("buckets an observation without a cited id and ignores unmarked signals", async () => {
    const { recordFromSignals } = await import("../src/commands/stats.js");
    const observation = renderCommentBody(
      {
        kind: "observation",
        severity: "MINOR",
        file: "src/app.js",
        line: 4,
        title: "Thought",
        body: "b",
      },
      "bbbb33334444",
    );
    const record = recordFromSignals("Ada", 10, "t", [
      { body: observation, reactions: { up: 0, down: 0 }, replies: [] },
      { body: "no marker here", reactions: { up: 0, down: 0 }, replies: [] },
    ]);
    expect(record.byGuideline["(observation)"]).toBe(1);
    expect(record.bySeverity.MINOR).toBe(1);
    expect(Object.keys(record.byGuideline)).toHaveLength(1);
  });

  it("skips malformed and wrong-shape ledger lines", async () => {
    const { readRecords } = await import("../src/stats/record.js");
    const repo = makeRepo();
    write(
      repo,
      "delta-peacock.stats.jsonl",
      [
        JSON.stringify({ at: "t", author: "Ada", addedLines: 1, bySeverity: {}, byGuideline: {} }),
        "{ not json",
        JSON.stringify({ author: 7, addedLines: "x" }),
        "",
      ].join("\n"),
    );
    const records = [...readRecords(repo, "delta-peacock.stats.jsonl")];
    expect(records).toHaveLength(1);
    expect(records[0]?.author).toBe("Ada");
  });

  it("counts an observation finding under its own bucket", async () => {
    const { guidelineCounts } = await import("../src/stats/record.js");
    expect(
      guidelineCounts([
        { kind: "observation", severity: "INFO", file: "a.js", line: 1, title: "t", body: "b" },
      ]),
    ).toEqual({ "(observation)": 1 });
  });
});

describe("stats backfill degradations", () => {
  const injected = (over: Record<string, unknown>) => ({
    listInlineComments: () => Promise.resolve([]),
    createInlineComment: () => Promise.resolve(),
    updateComment: () => Promise.resolve(),
    deleteComment: () => Promise.resolve(),
    listSummaryComments: () => Promise.resolve([]),
    createSummaryComment: () => Promise.resolve(),
    updateSummaryComment: () => Promise.resolve(),
    postStatus: () => Promise.resolve(),
    ...over,
  });

  const scmEnv = {
    DELTA_PEACOCK_SCM_PROVIDER: "github",
    DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
    DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    GITHUB_TOKEN: "t",
  };

  it("errors when the provider cannot read comment signals", async () => {
    let stderr = "";
    const code = await runCli(["stats", "--backfill"], {
      cwd: makeRepo(),
      env: scmEnv,
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model("{}"),
      scmPort: injected({}),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("cannot back stats out");
  });

  it("falls back to unknown author and zero lines without a diff source", async () => {
    const marked = renderCommentBody(
      {
        kind: "violation",
        guidelineId: "no-console",
        severity: "MAJOR",
        file: "a.js",
        line: 1,
        title: "T",
        body: "b",
      },
      "cccc55556666",
    );
    const repo = makeRepo();
    const code = await runCli(["stats", "--backfill"], {
      cwd: repo,
      env: scmEnv,
      out: () => undefined,
      err: () => undefined,
      modelPort: model("{}"),
      scmPort: injected({
        listCommentSignals: () =>
          Promise.resolve([{ body: marked, reactions: { up: 0, down: 0 }, replies: [] }]),
        getPullRequestAuthor: () => Promise.resolve(""),
      }),
    });
    expect(code).toBe(0);
    const records = [...readRecords(repo, "delta-peacock.stats.jsonl")];
    expect(records[0]?.author).toBe("(unknown)");
    expect(records[0]?.addedLines).toBe(0);
  });
});

describe("summarize", () => {
  it("folds many records per author and normalizes per hundred lines", () => {
    const records: StatsRecord[] = [
      { at: "t1", author: "Ada", addedLines: 100, bySeverity: { MAJOR: 2 }, byGuideline: { g: 2 } },
      { at: "t2", author: "Ada", addedLines: 100, bySeverity: { MINOR: 1 }, byGuideline: { h: 1 } },
      { at: "t3", author: "Bo", addedLines: 50, bySeverity: { BLOCKER: 5 }, byGuideline: { g: 5 } },
    ];
    const summaries = summarize(records);
    // sorted by findings, so Bo (5) leads Ada (3)
    expect(summaries[0]?.author).toBe("Bo");
    expect(summaries[0]?.per100Lines).toBeCloseTo(10);
    const ada = summaries.find((s) => s.author === "Ada");
    expect(ada?.reviews).toBe(2);
    expect(ada?.addedLines).toBe(200);
    expect(ada?.per100Lines).toBeCloseTo(1.5);
    expect(ada?.byGuideline).toEqual({ g: 2, h: 1 });
  });

  it("attributes empty authors to unknown and handles a zero-line review", () => {
    const summaries = summarize([
      { at: "t", author: "", addedLines: 0, bySeverity: {}, byGuideline: {} },
    ]);
    expect(summaries[0]?.author).toBe("(unknown)");
    expect(summaries[0]?.per100Lines).toBe(0);
    expect(renderStats(summaries)).toContain("(unknown)");
  });
});
