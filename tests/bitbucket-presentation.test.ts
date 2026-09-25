import { describe, expect, it } from "vitest";
import { recordFromSignals } from "../src/commands/stats.js";
import { fingerprintOf, type Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { publishReview } from "../src/scm/publish.js";
import { evidenceFrom } from "../src/guidelines/learn.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { BOT_UUID, startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINES = [
  "---\nid: no-console\nseverity: BLOCKER\n---\n# No console\n\nUse the logger.\n",
  "---\nid: no-todo\nseverity: MAJOR\n---\n# No TODO\n\nFile an issue instead.\n",
];

const TWO = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 1,
      quote: "console.log('x');",
      title: "Console",
      body: "Use the logger.",
    },
    {
      guidelineId: "no-todo",
      file: "src/app.js",
      line: 2,
      quote: "// TODO fix",
      title: "Todo",
      body: "File an issue.",
    },
  ],
});

const LEGACY_SUMMARY =
  "## delta-peacock review\n\nNo findings.\n\nGate: failOn=MAJOR passed.\n\n<!-- delta-peacock:summary -->";

function reviewedRepo(): string {
  const repo = makeRepo();
  GUIDELINES.forEach((guideline, index) => {
    write(repo, `guidelines/g${String(index)}.md`, guideline);
  });
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n// TODO fix\n");
  commitAll(repo, "change");
  return repo;
}

async function review(
  fake: FakeBitbucket,
  reply = TWO,
  repo = reviewedRepo(),
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const model: ModelPort = { complete: () => Promise.resolve({ text: reply }) };
  const code = await runCli(["review"], {
    cwd: repo,
    env: {
      DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
      BITBUCKET_TOKEN: "test-token",
    },
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: model,
  });
  return { code, stderr };
}

const summaries = (fake: FakeBitbucket) => fake.comments.filter((c) => c.inline === undefined);
const inline = (fake: FakeBitbucket) => fake.comments.filter((c) => c.inline !== undefined);

describe("bitbucket presentation", () => {
  it("posts no visible markers and re-runs idempotently by author plus heading", async () => {
    const fake = await startFakeBitbucket();
    try {
      await review(fake);
      expect(fake.drafts).toBe(0); // nothing to recognise yet, so no identity lookup
      expect(fake.comments.every((c) => !c.content.raw.includes("<!--"))).toBe(true);
      // no heading: the bot's name, the status and the card already say who reviewed
      expect(summaries(fake)[0]?.content.raw.split("\n")[0]).toBe("2 findings: 1 blocker, 1 major");
      expect(inline(fake)[0]?.content.raw).toBe(
        "**Blocker** · [no-console](https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md)\n\nUse the logger.",
      );

      const again = await review(fake);
      expect(again.stderr).toContain("0 created, 0 updated, 0 resolved, 2 unchanged");
      expect(fake.comments).toHaveLength(3);
      expect(fake.drafts).toBe(1); // one identity lookup per run, draft deleted
      expect(fake.comments.some((c) => c.pending === true)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("never touches a human comment that copies the heading", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.comments.push(
        {
          id: 900,
          content: { raw: "## Code review\n\nmine" },
          user: { uuid: "{human}" },
        },
        {
          id: 902,
          content: { raw: "No issues found in this change." },
          user: { uuid: "{human}" },
        },
        {
          id: 901,
          content: { raw: "**Blocker** · `no-console`\n\nI agree" },
          inline: { path: "src/app.js", to: 1 },
          user: { uuid: "{human}" },
        },
      );
      await review(fake);
      expect(fake.comments.find((c) => c.id === 900)?.content.raw).toBe("## Code review\n\nmine");
      expect(fake.comments.find((c) => c.id === 902)?.content.raw).toBe(
        "No issues found in this change.",
      );
      expect(fake.comments.find((c) => c.id === 901)?.content.raw).toContain("I agree");
      expect(summaries(fake)).toHaveLength(3);
      expect(inline(fake)).toHaveLength(3);
    } finally {
      await fake.close();
    }
  });

  it("replaces a pre 0.1.5 summary and inline comment in place", async () => {
    const fake = await startFakeBitbucket();
    try {
      const legacyPrint = fingerprintOf({
        kind: "violation",
        guidelineId: "no-console",
        severity: "BLOCKER",
        file: "src/app.js",
        line: 1,
        title: "",
        body: "",
      });
      fake.comments.push(
        { id: 50, content: { raw: LEGACY_SUMMARY }, user: { uuid: BOT_UUID } },
        {
          id: 51,
          content: {
            raw: `**BLOCKER** Console — \`no-console\`\n\nold\n\n<!-- delta-peacock:finding:${legacyPrint} -->`,
          },
          inline: { path: "src/app.js", to: 1 },
          user: { uuid: BOT_UUID },
        },
      );
      const { stderr } = await review(fake, JSON.stringify({ findings: [] }));
      expect(stderr).toContain("1 resolved");
      expect(summaries(fake)).toHaveLength(1);
      expect(summaries(fake)[0]?.id).toBe(50);
      // clean: no new summary on Bitbucket, but one of ours already there turns clean
      expect(summaries(fake)[0]?.content.raw).toBe("No issues found in this change.");

      fake.comments.push({
        id: 52,
        content: {
          raw: `**BLOCKER** Console — \`no-console\`\n\nold\n\n<!-- delta-peacock:finding:${legacyPrint} -->`,
        },
        inline: { path: "src/app.js", to: 1 },
        user: { uuid: BOT_UUID },
      });
      const second = await review(fake);
      expect(second.stderr).toContain("1 created, 1 updated");
      expect(fake.comments.find((c) => c.id === 52)?.content.raw.startsWith("**Blocker** · ")).toBe(
        true,
      );
    } finally {
      await fake.close();
    }
  });

  it("resolves stale and outdated own comments and folds duplicate summaries", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.userEndpoint = "ok";
      fake.comments.push(
        { id: 60, content: { raw: "## Code review\n\nold" }, user: { uuid: BOT_UUID } },
        { id: 61, content: { raw: "## Code review\n\nolder" }, user: { uuid: BOT_UUID } },
        {
          id: 62,
          content: { raw: "**Minor** · observation\n\ngone now" },
          inline: { path: "src/old.js", to: 4 },
          user: { uuid: BOT_UUID },
        },
      );
      // an outdated comment: Bitbucket drops the line once the code moves
      fake.comments.push({
        id: 63,
        content: { raw: "**Major** · `no-todo`\n\nmoved" },
        inline: { path: "src/app.js" } as { path: string; to: number },
        user: { uuid: BOT_UUID },
      });
      const { stderr } = await review(fake);
      expect(stderr).toContain("2 created, 0 updated, 2 resolved");
      expect(fake.drafts).toBe(0); // GET /user answered, no draft needed
      expect(summaries(fake).map((c) => c.id)).toEqual([60]);
    } finally {
      await fake.close();
    }
  });

  it("the fake refuses any comment or description carrying an HTML comment", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      await expect(
        port.createInlineComment({ body: "x\n\n<!-- m -->", path: "a.js", line: 1 }),
      ).rejects.toThrow(/400/);
      await expect(port.createSummaryComment("<!-- m -->")).rejects.toThrow(/400/);
      await port.createSummaryComment("plain");
      await expect(port.updateSummaryComment("1", "<!-- m -->")).rejects.toThrow(/400/);
      await expect(port.updatePullRequestText?.({ body: "<!-- m -->" })).rejects.toThrow(/400/);
    } finally {
      await fake.close();
    }
  });

  it("updates a persisting finding in place and resolves a discussed one that is gone", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = reviewedRepo();
      await review(fake, TWO, repo);
      const [consoleComment, todoComment] = inline(fake);
      fake.comments.push({
        id: 500,
        content: { raw: "fixed later" },
        inline: { path: "src/app.js", to: 2 },
        parent: { id: todoComment?.id ?? 0 },
        user: { uuid: "{human}" },
      });
      const reworded = JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 1,
            quote: "console.log('x');",
            title: "Console",
            body: "Route it through the logger.",
          },
        ],
      });
      const { stderr } = await review(fake, reworded, repo);
      expect(stderr).toContain("0 created, 1 updated, 1 resolved");
      const kept = fake.comments.find((c) => c.id === consoleComment?.id);
      expect(kept?.content.raw).toContain("Route it through the logger.");
      // the discussed thread stays, resolved, with its reply
      expect(fake.comments.find((c) => c.id === todoComment?.id)?.resolution).toBeTruthy();
      expect(fake.comments.some((c) => c.id === 500)).toBe(true);
      expect(fake.comments.every((c) => !c.content.raw.includes("<!--"))).toBe(true);

      // resolved threads are left alone and their finding is not reposted
      const third = await review(fake, TWO, repo);
      expect(third.stderr).toContain("0 created, 1 updated, 0 resolved, 1 unchanged");
      expect(inline(fake).filter((c) => c.parent === undefined)).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });

  it("tells apart findings sharing file, guideline and line without markers", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      const twin = (body: string): Finding => ({
        kind: "violation",
        guidelineId: "no-console",
        severity: "MAJOR",
        file: "src/app.js",
        line: 1,
        title: body,
        body,
      });
      const publish = (findings: Finding[]) =>
        publishReview(port, {
          findings,
          proposals: [],
          droppedUncited: 0,
          filtered: 0,
          gate: evaluateGate(findings, "BLOCKER"),
          commitStatus: false,
          codeInsights: false,
          dryRun: false,
        });
      await publish([twin("First."), twin("Second.")]);
      expect(inline(fake)).toHaveLength(2);
      const again = await publish([twin("First."), twin("Second.")]);
      expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
      const swapped = await publish([twin("Second."), twin("First.")]);
      expect(swapped).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 2 });
      const fewer = await publish([twin("Second.")]);
      expect(fewer).toMatchObject({ created: 0, updated: 0, deleted: 1, unchanged: 1 });
      expect(inline(fake).map((c) => c.content.raw)).toEqual([expect.stringContaining("Second.")]);
    } finally {
      await fake.close();
    }
  });

  it("surfaces an identity lookup failure that is not an access-token 403", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "teapot",
        baseUrl: fake.baseUrl,
      });
      await expect(port.currentUserId?.()).rejects.toThrow(/418/);
    } finally {
      await fake.close();
    }
  });

  it("links files on bitbucket.org at the target branch", () => {
    const port = createBitbucketPort({ repository: "acme/widgets", pullRequest: 7, token: "t" });
    expect(port.fileUrl?.("docs/reviews.md", "release/1.0")).toBe(
      "https://bitbucket.org/acme/widgets/src/release%2F1.0/docs/reviews.md",
    );
    expect(port.hidesHtmlComments).toBe(false);
  });
});

describe("file links on the other hosts", () => {
  it("github.com, an enterprise api, gitlab.com and a self-managed gitlab", async () => {
    const { createGitHubPort } = await import("../src/scm/github.js");
    const { createGitLabPort } = await import("../src/scm/gitlab.js");
    const options = { repository: "acme/widgets", pullRequest: 7, token: "t" };
    expect(createGitHubPort(options).fileUrl?.("guidelines/a.md", "main")).toBe(
      "https://github.com/acme/widgets/blob/main/guidelines/a.md",
    );
    expect(
      createGitHubPort({ ...options, baseUrl: "https://ghe.example/api/v3" }).fileUrl?.(
        "a.md",
        "dev",
      ),
    ).toBe("https://ghe.example/acme/widgets/blob/dev/a.md");
    expect(createGitLabPort(options).fileUrl?.("a.md", "main")).toBe(
      "https://gitlab.com/acme/widgets/-/blob/main/a.md",
    );
    expect(
      createGitLabPort({ ...options, baseUrl: "https://git.example/api/v4" }).fileUrl?.(
        "a.md",
        "x",
      ),
    ).toBe("https://git.example/acme/widgets/-/blob/x/a.md");
  });
});

describe("learn and stats read unmarked own comments", () => {
  const body = "**Major** · [no-todo](u)\n\nFile an issue. Now.";

  it("counts the reviewer's own heading comments and skips everyone else's", () => {
    const signals = [
      { body, path: "a.js", line: 3, own: true, reactions: { up: 0, down: 0 }, replies: ["ok"] },
      { body, path: "a.js", line: 3, own: false, reactions: { up: 0, down: 0 }, replies: [] },
    ];
    const evidence = evidenceFrom(signals);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      guidelineId: "no-todo",
      severity: "MAJOR",
      title: "File an issue.",
      replies: ["ok"],
    });
    const record = recordFromSignals("dev", 10, "2026-09-25T00:00:00Z", signals);
    expect(record.bySeverity).toEqual({ MAJOR: 1 });
    expect(record.byGuideline).toEqual({ "no-todo": 1 });
  });

  it("bitbucket signals say which comments are the token's own", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.comments.push(
        {
          id: 101,
          content: { raw: body },
          inline: { path: "a.js", to: 3 },
          user: { uuid: BOT_UUID },
        },
        { id: 102, content: { raw: body }, user: { uuid: "{human}" } },
      );
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      const signals = (await port.listCommentSignals?.()) ?? [];
      expect(signals.map((s) => [s.own, s.line])).toEqual([
        [true, 3],
        [false, undefined],
      ]);
    } finally {
      await fake.close();
    }
  });
});
