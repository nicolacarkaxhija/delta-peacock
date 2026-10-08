import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintOf, type Finding } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { DEFAULT_PRESENTATION, renderSummaryBody } from "../src/scm/comment-format.js";
import { createGitHubPort } from "../src/scm/github.js";
import { createGitLabPort } from "../src/scm/gitlab.js";
import type { ScmComment, ScmPort, ScmTask } from "../src/scm/port.js";
import {
  lineDigest,
  publishReview,
  type GuidelineSource,
  type PresentationSettings,
} from "../src/scm/publish.js";
import { BOT_UUID, startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { startFakeGitLab } from "./helpers/fake-gitlab.js";

const REVIEWED = "5c11e1ff8352ed06fbac1978bcf7edb723ead510";
const RULES = "4768568a7121f2c4779504c80fc958e40e1cc9cc";
const LATER = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const LINE = "test.describe('cart totals', () => {";
const FILE = "tests/cart/totals.spec.ts";
const SITE = "https://bitbucket.org/ws/repo";
const GUIDE = `${SITE}/src/${RULES}/guidelines/testing/spec-naming.md`;
const DOCS = `[docs/reviews.md](${SITE}/src/main/docs/reviews.md)`;

const finding: Finding = {
  kind: "violation",
  guidelineId: "spec-named-for-feature",
  severity: "MINOR",
  file: FILE,
  line: 1,
  title: "Spec name",
  body: "Name the spec for what it checks.",
  guidelineQuote: "A spec file is named for the feature it checks.",
};
const FINGERPRINT = fingerprintOf(finding);
const REF = `ref ${FINGERPRINT}.${lineDigest(LINE)}`;

const REASON =
  "Name the spec for what it checks.\n\nGuideline: A spec file is named for the feature it checks.";
const LINKED_BODY = `**Medium** · [spec-named-for-feature](${GUIDE})\n\n${REASON}`;
const RESOLVED_TAIL = "the flagged line changed or the finding no longer holds.";
/** The plain task text earlier versions wrote; still matched by its reference. */
const TASK = `Medium: spec-named-for-feature in ${FILE} line 1, ${REF}`;

/** The headings earlier versions wrote for the same finding. */
const OLD_HEADINGS = {
  "on a host it could not link": "**Medium** · `spec-named-for-feature`",
  "with a link on the target branch": `**Medium** · [spec-named-for-feature](${SITE}/src/main/guidelines/spec-named-for-feature.md)`,
};

/** Two high findings on one file. */
const skipped = (line: number): Finding => ({
  kind: "violation",
  guidelineId: "skip-with-reason",
  severity: "MAJOR",
  file: "tests/cart/discounts.spec.ts",
  line,
  title: "Skip without a reason",
  body: "Give the skip its reason.",
});
const SKIP_GUIDE = `${SITE}/src/${RULES}/guidelines/skips.md`;
const OLD_SUMMARY = [
  "2 findings: 2 high",
  "",
  `- **High** [skip-with-reason](${SITE}/src/main/guidelines/skip-with-reason.md) in \`tests/cart/discounts.spec.ts\` line 16: Skip without a reason`,
  `- **High** [skip-with-reason](${SITE}/src/main/guidelines/skip-with-reason.md) in \`tests/cart/discounts.spec.ts\` line 20: Skip without a reason`,
  "",
  "**Blocked: 2 high findings must be resolved.**",
  "",
  `How reviews work and how to respond: ${DOCS}`,
].join("\n");

function settings(commit = RULES): PresentationSettings {
  const files: ReadonlyMap<string, GuidelineSource> = new Map([
    ["spec-named-for-feature", { path: "guidelines/testing/spec-naming.md", commit }],
    ["skip-with-reason", { path: "guidelines/skips.md", commit }],
  ]);
  return {
    displayName: "Code review",
    guidelinesDir: "guidelines",
    targetBranch: "main",
    guidePath: "docs/reviews.md",
    guidelineFiles: files,
  };
}

let fake: FakeBitbucket;
let port: ScmPort;

beforeEach(async () => {
  fake = await startFakeBitbucket();
  fake.userEndpoint = "ok";
  port = createBitbucketPort({
    repository: "ws/repo",
    pullRequest: 10,
    token: "test-token",
    baseUrl: fake.baseUrl,
  });
});

afterEach(async () => {
  await fake.close();
});

type PublishInput = Parameters<typeof publishReview>[1];

function publishOn(scm: ScmPort, findings: Finding[], extra: Partial<PublishInput> = {}) {
  return publishReview(scm, {
    findings,
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate(findings, "MAJOR"),
    commitStatus: false,
    reviewedCommit: REVIEWED,
    presentation: settings(),
    dryRun: false,
    ...extra,
  });
}

function publish(
  findings: Finding[],
  options: { lineText?: string; reviewedCommit?: string; presentation?: PresentationSettings } = {},
) {
  return publishOn(port, findings, {
    tasks: true,
    lineTextOf: () => options.lineText ?? LINE,
    reviewedCommit: options.reviewedCommit ?? REVIEWED,
    presentation: options.presentation ?? settings(),
  });
}

const inline = () => fake.comments.filter((comment) => comment.inline !== undefined);
const summaries = () => fake.comments.filter((comment) => comment.inline === undefined);

function seedOldComment(heading: string): void {
  fake.comments.push({
    id: 70,
    content: { raw: `${heading}\n\n${REASON}` },
    inline: { path: FILE, to: 1 },
    user: { uuid: BOT_UUID },
  });
  fake.tasks.push({ id: 71, content: { raw: TASK }, comment: { id: 70 }, state: "UNRESOLVED" });
}

describe("addresses each host builds", () => {
  it("bitbucket cloud: a commit, a file at a commit on a line, and a comment", () => {
    const bitbucket = createBitbucketPort({ repository: "ws/repo", pullRequest: 10, token: "t" });
    expect(bitbucket.commitUrl?.(REVIEWED)).toBe(`${SITE}/commits/${REVIEWED}`);
    expect(bitbucket.fileUrl?.(FILE, REVIEWED, 1)).toBe(`${SITE}/src/${REVIEWED}/${FILE}#lines-1`);
    expect(bitbucket.fileUrl?.("docs/a (b).md", "main")).toBe(
      `${SITE}/src/main/docs/a%20%28b%29.md`,
    );
    expect(bitbucket.commentUrl?.("42")).toBe(`${SITE}/pull-requests/10#comment-42`);
  });

  it("github.com and an enterprise server", () => {
    const options = { repository: "acme/widgets", pullRequest: 7, token: "t" };
    const github = createGitHubPort(options);
    const web = "https://github.com/acme/widgets";
    expect(github.commitUrl?.(REVIEWED)).toBe(`${web}/commit/${REVIEWED}`);
    expect(github.fileUrl?.("src/app.ts", REVIEWED, 3)).toBe(
      `${web}/blob/${REVIEWED}/src/app.ts#L3`,
    );
    expect(github.fileUrl?.("src/app.ts", "main")).toBe(`${web}/blob/main/src/app.ts`);
    expect(github.commentUrl?.("9")).toBe(`${web}/pull/7#discussion_r9`);
    const enterprise = createGitHubPort({ ...options, baseUrl: "https://ghe.example/api/v3" });
    expect(enterprise.commentUrl?.("9")).toBe(
      "https://ghe.example/acme/widgets/pull/7#discussion_r9",
    );
  });

  it("gitlab.com with a subgroup", () => {
    const gitlab = createGitLabPort({ repository: "acme/web/widgets", pullRequest: 7, token: "t" });
    const web = "https://gitlab.com/acme/web/widgets";
    expect(gitlab.commitUrl?.(REVIEWED)).toBe(`${web}/-/commit/${REVIEWED}`);
    expect(gitlab.fileUrl?.("src/app.ts", REVIEWED, 3)).toBe(
      `${web}/-/blob/${REVIEWED}/src/app.ts#L3`,
    );
    expect(gitlab.commentUrl?.("5")).toBe(`${web}/-/merge_requests/7#note_5`);
  });

  it("github and gitlab statuses link the pull request, and new comments name their id", async () => {
    const github = await startFakeGitHub();
    const gitlab = await startFakeGitLab();
    try {
      const options = { repository: "acme/widgets", pullRequest: 7, token: "test-token" };
      const hub = createGitHubPort({ ...options, baseUrl: github.baseUrl });
      const lab = createGitLabPort({ ...options, baseUrl: gitlab.baseUrl });
      await hub.postStatus("success", "ok");
      await lab.postStatus("success", "ok");
      expect(github.statuses[0]?.targetUrl).toBe(`${github.baseUrl}/acme/widgets/pull/7`);
      expect(gitlab.statuses[0]?.targetUrl).toBe(
        `${gitlab.baseUrl.replace(/\/api\/v4$/, "")}/acme/widgets/-/merge_requests/7`,
      );
      const comment = { body: "b", path: "src/app.js", line: 1 };
      expect(await hub.createInlineComment(comment)).toBe(String(github.reviewComments[0]?.id));
      expect(await lab.createInlineComment(comment)).toBe(String(gitlab.notes[0]?.id));
    } finally {
      await github.close();
      await gitlab.close();
    }
  });
});

describe("inline comments on a bitbucket pull request", () => {
  it("link the guideline in the heading, and the guideline and comment in the task", async () => {
    const outcome = await publish([finding]);
    expect(outcome.created).toBe(1);
    expect(inline()[0]?.content.raw).toBe(LINKED_BODY);
    const comment = `${SITE}/pull-requests/10#comment-${String(inline()[0]?.id)}`;
    expect(fake.tasks.map((task) => task.content.raw)).toEqual([
      `Medium: [spec-named-for-feature](${GUIDE}) in [${FILE} line 1](${comment}), ${REF}`,
    ]);
  });

  it("keep a pack guideline in code, since it has no file in the repository", async () => {
    await publish([{ ...finding, pack: "team" }]);
    expect(inline()[0]?.content.raw).toBe(`**Medium** · \`spec-named-for-feature\`\n\n${REASON}`);
    expect(summaries()[0]?.content.raw).toContain("- **Medium** `spec-named-for-feature` in [");
  });

  it("link the resolving commit and the guideline in the trace, keeping its start", async () => {
    await publish([finding]);
    await publish([], { lineText: "changed" });
    const trace = inline()[0]?.content.raw ?? "";
    expect(trace).toBe(
      `**Medium** · [spec-named-for-feature](${GUIDE})\n\nResolved in [5c11e1ff8352](${SITE}/commits/${REVIEWED}): ${RESOLVED_TAIL}`,
    );
    expect(trace).not.toContain("`");
  });

  it("are not rewritten for a new commit alone", async () => {
    await publish([finding]);
    const id = String(inline()[0]?.id);
    const writes = fake.writes.length;
    const again = await publish([finding], {
      reviewedCommit: LATER,
      presentation: settings(LATER),
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const touched = fake.writes
      .slice(writes)
      .filter((write) => write.url.endsWith(`/comments/${id}`));
    expect(touched).toEqual([]);
    expect(inline()[0]?.content.raw).toBe(LINKED_BODY);
  });
});

describe("the summary on a bitbucket pull request", () => {
  it("links each guideline, each finding to its own comment and the guide on the target branch", async () => {
    await publish([skipped(16), skipped(20)]);
    const [first, second] = inline().map((comment) => comment.id);
    const place = (line: number, id: number | undefined) =>
      `[tests/cart/discounts.spec.ts line ${String(line)}](${SITE}/pull-requests/10#comment-${String(id)})`;
    expect(summaries()[0]?.content.raw).toBe(
      [
        "2 findings: 2 high",
        "",
        `- **High** [skip-with-reason](${SKIP_GUIDE}) in ${place(16, first)}: Skip without a reason`,
        `- **High** [skip-with-reason](${SKIP_GUIDE}) in ${place(20, second)}: Skip without a reason`,
        "",
        "**Blocked: 2 high findings must be resolved.**",
        "",
        `How reviews work and how to respond: ${DOCS}`,
      ].join("\n"),
    );
  });

  it("links a finding with no comment to its file at the reviewed commit, and facts in the first line", async () => {
    const unplaced: Finding = {
      ...finding,
      line: 0,
      unplaced: true,
      note: "The review did not quote the line it means, so this finding is not placed on a line.",
    };
    await publishOn(port, [unplaced], {
      codeInsights: true,
      factsOnly: { left: 0, notReviewed: ["spec-named-for-feature", "pack-rule"] },
    });
    const summary = summaries()[0]?.content.raw;
    expect(summary).toContain(`not reviewed ([spec-named-for-feature](${GUIDE}), pack-rule).`);
    expect(summary).toContain(
      `- **Medium** [spec-named-for-feature](${GUIDE}) in [${FILE}](${SITE}/src/${REVIEWED}/${FILE}): Spec name.`,
    );
    expect(summary).not.toMatch(/`tests\//);
    // the report card takes plain text only, its annotations one link each
    expect(String(fake.insightReport?.["details"])).not.toContain("](");
    expect(fake.insightAnnotations.map((annotation) => annotation.link)).toEqual([GUIDE]);
  });

  it("takes over a summary an earlier version wrote and is found again by the next run", async () => {
    fake.comments.push({ id: 90, content: { raw: OLD_SUMMARY }, user: { uuid: BOT_UUID } });
    await publish([skipped(16), skipped(20)]);
    expect(summaries().map((comment) => comment.id)).toEqual([90]);
    const taken = summaries()[0]?.content.raw ?? "";
    expect(taken).toContain(`${SITE}/pull-requests/10#comment-`);
    expect(taken).not.toContain("`tests/");

    const writes = fake.writes.length;
    await publish([skipped(16), skipped(20)]);
    expect(summaries().map((comment) => [comment.id, comment.content.raw])).toEqual([[90, taken]]);
    expect(fake.writes.slice(writes).some((write) => write.url.endsWith("/comments/90"))).toBe(
      false,
    );
  });

  it("takes over a facts only summary an earlier version wrote", async () => {
    const old =
      "This review checked facts only, with no model: 0 findings, 0 candidates left to a person because they need a judgement, and 1 guideline not reviewed (spec-named-for-feature).";
    fake.comments.push({ id: 91, content: { raw: old }, user: { uuid: BOT_UUID } });
    await publishOn(port, [], { factsOnly: { left: 0, notReviewed: ["spec-named-for-feature"] } });
    expect(summaries().map((comment) => [comment.id, comment.content.raw])).toEqual([
      [91, old.replace("(spec-named-for-feature)", `([spec-named-for-feature](${GUIDE}))`)],
    ]);
  });
});

describe("the guide named in a blocked summary", () => {
  const blocked = {
    findings: [skipped(16)],
    proposals: [],
    droppedUncited: 0,
    filtered: 0,
    gate: evaluateGate([skipped(16)], "MAJOR"),
  };

  it("is plain text when it is not on the target branch yet, or the host links nothing", () => {
    const guide = { ...DEFAULT_PRESENTATION, guidePath: "docs/reviews.md" };
    const withLinks = { ...guide, fileLink: (file: string) => `${SITE}/src/main/${file}` };
    const last = (presentation: typeof guide) =>
      renderSummaryBody(blocked, presentation).trimEnd().split("\n").at(-3);
    expect(last(withLinks)).toBe(`How reviews work and how to respond: ${DOCS}`);
    expect(last({ ...withLinks, guideLinked: false })).toBe(
      "How reviews work and how to respond: docs/reviews.md",
    );
    expect(last(guide)).toBe("How reviews work and how to respond: docs/reviews.md");
  });
});

describe("comments an earlier version wrote without links", () => {
  for (const [version, heading] of Object.entries(OLD_HEADINGS)) {
    it(`claims one written ${version} and updates it in place, with no second comment or task`, async () => {
      seedOldComment(heading);
      const outcome = await publish([finding]);
      expect(outcome).toMatchObject({ created: 0, updated: 1, deleted: 0 });
      expect(outcome.tasksCreated).toBeUndefined();
      expect(inline().map((comment) => [comment.id, comment.content.raw])).toEqual([
        [70, LINKED_BODY],
      ]);
      expect(fake.tasks.map((task) => [task.id, task.state, task.content.raw])).toEqual([
        [71, "UNRESOLVED", TASK],
      ]);

      const again = await publish([finding]);
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
      expect(fake.tasks).toHaveLength(1);
    });

    it(`resolves one written ${version} as before once its finding is gone`, async () => {
      seedOldComment(heading);
      const outcome = await publish([], { lineText: "test.describe('cart sums', () => {" });
      expect(outcome).toMatchObject({ created: 0, deleted: 1, tasksResolved: 1 });
      const [comment] = inline();
      expect(comment?.id).toBe(70);
      expect(comment?.resolution).toBeTruthy();
      expect(comment?.content.raw).toBe(
        `**Medium** · [spec-named-for-feature](${GUIDE})\n\nResolved in [5c11e1ff8352](${SITE}/commits/${REVIEWED}): ${RESOLVED_TAIL}`,
      );
      expect(fake.tasks.map((task) => [task.id, task.state])).toEqual([[71, "RESOLVED"]]);
    });
  }

  it("turns the hash of an earlier trace into a commit link once, and leaves a person's copy alone", async () => {
    const oldTrace = `**Medium** · \`spec-named-for-feature\`\n\nResolved in \`5c11e1ff8352\`: ${RESOLVED_TAIL}`;
    fake.comments.push(
      {
        id: 80,
        content: { raw: oldTrace },
        inline: { path: FILE, to: 1 },
        user: { uuid: BOT_UUID },
        resolution: { type: "resolved" },
      },
      {
        id: 81,
        content: { raw: oldTrace },
        inline: { path: FILE, to: 1 },
        user: { uuid: "{human}" },
      },
    );
    const outcome = await publish([]);
    expect(outcome).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    expect(inline().map((comment) => [comment.id, comment.content.raw])).toEqual([
      [
        80,
        `**Medium** · [spec-named-for-feature](${GUIDE})\n\nResolved in [5c11e1ff8352](${SITE}/commits/5c11e1ff8352): ${RESOLVED_TAIL}`,
      ],
      [81, oldTrace],
    ]);
    const writes = fake.writes.length;
    expect(await publish([])).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(fake.writes.slice(writes).filter((write) => write.method === "PUT")).toEqual([]);
  });
});

describe("a github pull request", () => {
  it("updates a marked comment and the summary in place, links the trace and the finding's comment", async () => {
    const github = await startFakeGitHub();
    try {
      const hub = createGitHubPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: github.baseUrl,
      });
      const marker = `<!-- delta-peacock:finding:${FINGERPRINT} -->`;
      github.reviewComments.push(
        {
          id: 1,
          body: `**Minor** · \`spec-named-for-feature\`\n\n${REASON}\n\n${marker}`,
          path: FILE,
          line: 1,
        },
        {
          id: 2,
          body: `**Minor** · \`spec-named-for-feature\`\n\nResolved in \`5c11e1ff8352\`: ${RESOLVED_TAIL}`,
          path: FILE,
          line: 9,
        },
      );
      github.issueComments.push({
        id: 3,
        body: `1 finding: 1 minor\n\n- **Minor** \`spec-named-for-feature\` in \`${FILE}\` line 1: Spec name\n\n<!-- delta-peacock:summary -->`,
      });
      const outcome = await publishOn(hub, [finding]);
      const web = `${github.baseUrl}/acme/widgets`;
      const guide = `${web}/blob/${RULES}/guidelines/testing/spec-naming.md`;
      expect(outcome).toMatchObject({ created: 0, updated: 2 });
      expect(github.reviewComments.map((comment) => comment.body)).toEqual([
        `**Minor** · [spec-named-for-feature](${guide})\n\n${REASON}\n\n${marker}`,
        `**Minor** · [spec-named-for-feature](${guide})\n\nResolved in [5c11e1ff8352](${web}/commit/5c11e1ff8352): ${RESOLVED_TAIL}`,
      ]);
      expect(github.issueComments.map((comment) => [comment.id, comment.body])).toEqual([
        [
          3,
          `1 finding: 1 minor\n\n- **Minor** [spec-named-for-feature](${guide}) in [${FILE} line 1](${web}/pull/7#discussion_r1): Spec name\n\n<!-- delta-peacock:summary -->`,
        ],
      ]);
    } finally {
      await github.close();
    }
  });

  it("names the files no model reviewed and the comments it left alone, each linked", async () => {
    const github = await startFakeGitHub();
    try {
      const hub = createGitHubPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: github.baseUrl,
      });
      const earlier = { ...finding, file: "src/old.ts", line: 4 };
      const marker = `<!-- delta-peacock:finding:${fingerprintOf(earlier)} -->`;
      github.reviewComments.push({
        id: 1,
        body: `**Minor** · \`spec-named-for-feature\`\n\n${REASON}\n\n${marker}`,
        path: "src/old.ts",
        line: 4,
      });
      await publishOn(hub, [], {
        factsOnly: {
          left: 0,
          notReviewed: [],
          fallback: "unreachable",
          modelReviewed: "part",
          unjudgedFiles: ["src/new (draft).ts"],
        },
      });
      const web = `${github.baseUrl}/acme/widgets`;
      const summary = github.issueComments[0]?.body ?? "";
      expect(summary).toContain(
        `no model reviewed [src/new (draft).ts](${web}/blob/${REVIEWED}/src/new%20%28draft%29.ts), where`,
      );
      expect(summary).toContain(
        `so their comments stay as they are: [src/old.ts:4](${web}/pull/7#discussion_r1).`,
      );
      expect(github.reviewComments[0]?.body).toContain(`\`spec-named-for-feature\``);
    } finally {
      await github.close();
    }
  });
});

describe("a gitlab merge request", () => {
  it("links the guideline, the finding's note and the resolving commit", async () => {
    const gitlab = await startFakeGitLab();
    try {
      const lab = createGitLabPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: gitlab.baseUrl,
      });
      await publishOn(lab, [finding]);
      const web = `${gitlab.baseUrl.replace(/\/api\/v4$/, "")}/acme/widgets`;
      const guide = `${web}/-/blob/${RULES}/guidelines/testing/spec-naming.md`;
      const note = gitlab.notes.find((entry) => entry.position !== undefined);
      expect(note?.body.split("\n")[0]).toBe(`**Minor** · [spec-named-for-feature](${guide})`);
      const summary = gitlab.notes.find((entry) => entry.position === undefined)?.body ?? "";
      expect(summary).toContain(
        `in [${FILE} line 1](${web}/-/merge_requests/7#note_${String(note?.id)}): Spec name`,
      );

      await publishOn(lab, []);
      expect(gitlab.notes.find((entry) => entry.id === note?.id)?.body).toBe(
        `**Minor** · [spec-named-for-feature](${guide})\n\nResolved in [5c11e1ff8352](${web}/-/commit/${REVIEWED}): ${RESOLVED_TAIL}`,
      );
    } finally {
      await gitlab.close();
    }
  });
});

describe("a host that cannot build addresses", () => {
  it("keeps plain text and writes no link", async () => {
    const bodies: string[] = [];
    const comments: ScmComment[] = [];
    const tasks: ScmTask[] = [];
    const plain: ScmPort = {
      hidesHtmlComments: false,
      currentUserId: () => Promise.resolve("me"),
      listInlineComments: () => Promise.resolve(comments),
      createInlineComment: (comment) => {
        bodies.push(comment.body);
        comments.push({
          id: "1",
          body: comment.body,
          path: comment.path,
          line: comment.line,
          authorId: "me",
        });
        return Promise.resolve("1");
      },
      listTasks: () => Promise.resolve(tasks),
      createTask: (content) => {
        bodies.push(content);
        return Promise.resolve();
      },
      resolveTask: () => Promise.resolve(),
      updateComment: (_id, body) => {
        bodies.push(body);
        return Promise.resolve();
      },
      deleteComment: () => Promise.resolve(),
      listSummaryComments: () => Promise.resolve([]),
      createSummaryComment: (body) => {
        bodies.push(body);
        return Promise.resolve();
      },
      updateSummaryComment: () => Promise.resolve(),
      postStatus: () => Promise.resolve(),
    };
    const run = (findings: Finding[]) =>
      publishOn(plain, findings, {
        gate: evaluateGate(findings, "MINOR"),
        tasks: true,
        lineTextOf: () => LINE,
      });
    const unplaced: Finding = { ...finding, file: "a.ts", unplaced: true, note: "Not on a line." };
    await run([finding, unplaced]);
    await run([]);
    expect(bodies.join("\n")).not.toContain("](");
    expect(bodies).toContain(`Minor: spec-named-for-feature in ${FILE} line 1, ${REF}`);
    expect(bodies[2]).toContain(`in \`${FILE}\` line 1: Spec name`);
    expect(bodies[2]).toContain("in `a.ts`: Spec name. Not on a line.");
    expect(bodies[2]).toContain("How reviews work and how to respond: docs/reviews.md");
    expect(bodies.at(-2)).toBe(
      `**Minor** · \`spec-named-for-feature\`\n\nResolved in \`5c11e1ff8352\`: ${RESOLVED_TAIL}`,
    );
  });
});
