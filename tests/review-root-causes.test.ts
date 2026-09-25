import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { linesAtHead } from "../src/review/run-review.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelReply, ModelRequest } from "../src/model/port.js";
import { declaredTags, keysAt, objectKeysByPath } from "../src/review/declared.js";
import { examplesOf } from "../src/review/examples.js";
import { plainBody, plainTitle } from "../src/review/prose.js";
import { BOT_UUID, startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

// the consumer's guideline and spec from its first reviewed pull request, verbatim
const AXIS_TAGS = [
  "---",
  "id: axis-tags",
  "severity: MINOR",
  "languages: [typescript]",
  "paths: ['tests/**']",
  "---",
  "",
  "# Axis tags restrict or exclude only where a test must; a feature tag names what it covers",
  "",
  "Beside them a test should carry one feature tag from `tags.features` in `test-runner.config.ts`, so `--grep @cart` reaches every cart test. This is a recommendation: `test-runner check` accepts a test without one.",
  "",
  "Good:",
  "",
  "```ts",
  "test('the cart shows the added line', { tag: ['@cart'] }, async ({ cart }) => {",
  "```",
  "",
  "```ts",
  "test('the hero carousel renders a slide', { tag: ['@not-site:US'] }, async ({ home }) => {",
  "```",
  "",
  "Bad:",
  "",
  "```ts",
  "test('the homepage renders', { tag: ['@not-site:US', '@smoke'] }, async ({ home }) => {",
  "```",
  "",
].join("\n");

const SPEC = [
  "import { expect, test } from '../../support/fixtures.js';",
  "",
  "test(",
  "  'Homepage renders a hero carousel with at least one slide',",
  "  { tag: ['@not-site:US'] },",
  "  async ({ home }) => {",
  "    await home.open();",
  "  },",
  ");",
  "",
].join("\n");

const RUNNER_CONFIG = [
  "export default defineConfig({",
  "  suite: {",
  "    // sites and their locales",
  "    sites: {",
  "      EU: { defaultLocale: 'de', locales: { de: { pathPrefix: '/de' }, fr: {} } },",
  "      US: { defaultLocale: 'en', locales: { en: {} } },",
  "    },",
  "    environments: { stg: { hostTemplate: 'https://stg.example.com' } },",
  "    devices: { desktop: { viewport: { width: 1400 } }, mobile: {} },",
  "    tags: {",
  "      features: {",
  "        checkout: 'the checkout funnel, from the guest choice screen',",
  "        cart: 'the cart page',",
  "        'pdp-types': 'the pinned product types',",
  "      },",
  "    },",
  "  },",
  "});",
  "",
].join("\n");

function consumerRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/axis-tags.md", AXIS_TAGS);
  write(repo, "test-runner.config.ts", RUNNER_CONFIG);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "test/homepage-hero-carousel");
  write(repo, "tests/smoke/homepage.spec.ts", SPEC);
  commitAll(repo, "test(home): cover the hero carousel");
  return repo;
}

/** The finding 0.1.3 posted on the consumer's PR 1, as the model wrote it. */
const WRONG_FINDING = {
  guidelineId: "axis-tags",
  file: "tests/smoke/homepage.spec.ts",
  line: 3,
  quote: "  { tag: ['@not-site:US'] },",
  title: "Missing feature tag — axis-tags",
  body: "According to the guideline, a test should carry one feature tag from tags.features.",
  suggestion: "  { tag: ['@not-site:US', '@homepage'] },",
  guidelineQuote: "Axis tags restrict or exclude only where a test must",
};

function scripted(...replies: ModelReply[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve(
          replies[Math.min(requests.length - 1, replies.length - 1)] ?? { text: "" },
        );
      },
    },
  };
}

async function reviewOnBitbucket(
  fake: FakeBitbucket,
  repo: string,
  port: ModelPort,
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const code = await runCli(["review"], {
    cwd: repo,
    env: {
      DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/e2e",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "1",
      DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
      BITBUCKET_TOKEN: "test-token",
    },
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: port,
  });
  return { code, stderr };
}

const summaryOf = (fake: FakeBitbucket) =>
  fake.comments.find((comment) => comment.inline === undefined)?.content.raw ?? "";
const inlineOf = (fake: FakeBitbucket) => fake.comments.filter((c) => c.inline !== undefined);

describe("PR 1 root causes, replayed", () => {
  it("drops a finding on code its own guideline shows as the Good example", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = consumerRepo();
      const { code, stderr } = await reviewOnBitbucket(
        fake,
        repo,
        scripted({ text: JSON.stringify({ findings: [WRONG_FINDING] }) }).port,
      );
      expect(code).toBe(0);
      expect(stderr).toContain("matches the guideline's own Good example");
      expect(inlineOf(fake)).toHaveLength(0);
      // clean on Bitbucket: the status and the Insights card carry it, no summary comment
      expect(summaryOf(fake)).toBe("");
      expect(fake.statuses.at(-1)?.description).toBe("Passed. No findings in 1 changed file.");
      expect(fake.insightReport?.["details"]).toBe("No issues found in this change.");
    } finally {
      await fake.close();
    }
  });

  it("anchors on the quoted line and never keeps a suggestion naming an undeclared tag", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = consumerRepo();
      const finding = {
        ...WRONG_FINDING,
        quote: "  'Homepage renders a hero carousel with at least one slide',",
        suggestion: "  'Homepage renders a hero carousel @homepage',",
      };
      await reviewOnBitbucket(
        fake,
        repo,
        scripted({ text: JSON.stringify({ findings: [finding] }) }).port,
      );
      const [comment] = inlineOf(fake);
      expect(comment?.inline).toMatchObject({ path: "tests/smoke/homepage.spec.ts", to: 4 });
      const body = comment?.content.raw ?? "";
      expect(body).not.toContain("```");
      expect(body).toContain("`@homepage` is not a tag test-runner.config.ts declares");
      expect(body).not.toMatch(/According to|—|–/);
      expect(summaryOf(fake)).toContain("line 4: Missing feature tag");
      expect(summaryOf(fake)).not.toMatch(/—|–|failOn/);
    } finally {
      await fake.close();
    }
  });

  it("posts a finding whose quote is nowhere in the file on no line, in the summary only", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = consumerRepo();
      const finding = { ...WRONG_FINDING, quote: "test('something else', async () => {" };
      await reviewOnBitbucket(
        fake,
        repo,
        scripted({ text: JSON.stringify({ findings: [finding] }) }).port,
      );
      expect(inlineOf(fake)).toHaveLength(0);
      expect(summaryOf(fake)).toContain("so this finding is not placed on a line");
      expect(fake.insightAnnotations[0]?.line).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it("tells the model the rules and the tags the repository declares", async () => {
    const fake = await startFakeBitbucket();
    try {
      const model = scripted({ text: '{"findings": []}' });
      await reviewOnBitbucket(fake, consumerRepo(), model.port);
      const system = model.requests[0]?.system ?? "";
      expect(system).toContain(
        "Code that matches a guideline's Good example, verbatim or in structure, is never a finding",
      );
      expect(system).toContain('"quote"');
      expect(system).toContain("may not introduce a tag, identifier or import");
      expect(system).toContain("## Tags declared in test-runner.config.ts");
      expect(system).toContain("Feature tags: @checkout, @cart, @pdp-types");
      expect(system).toContain("@not-site:US");
    } finally {
      await fake.close();
    }
  });
});

describe("a reply with no JSON", () => {
  it("retries the answer once, with the fetched files as text and no tools", async () => {
    const fake = await startFakeBitbucket();
    try {
      const finding = { ...WRONG_FINDING, quote: "    await home.open();", suggestion: undefined };
      const model = scripted(
        {
          text: "Let me check the fixtures to understand the structure better:",
          transcript: "[result of read_file_range]\nexport const test = base.extend({});",
          usage: { inputTokens: 10, outputTokens: 2 },
          toolCalls: 3,
        },
        {
          text: JSON.stringify({ findings: [finding] }),
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      );
      const { code } = await reviewOnBitbucket(fake, consumerRepo(), model.port);
      expect(code).toBe(0);
      expect(model.requests).toHaveLength(2);
      const retry = model.requests[1];
      expect(retry?.tools).toBeUndefined();
      expect(retry?.user).toContain("export const test = base.extend({});");
      expect(retry?.user).toContain("That reply held no JSON answer");
      expect(inlineOf(fake)[0]?.inline).toMatchObject({ to: 7 });
    } finally {
      await fake.close();
    }
  });

  it("posts a could-not-complete summary and a failed status after the retry fails", async () => {
    const fake = await startFakeBitbucket();
    try {
      const model = scripted({ text: "I need to look at more files first." });
      const { code, stderr } = await reviewOnBitbucket(fake, consumerRepo(), model.port);
      expect(code).toBe(1);
      expect(model.requests).toHaveLength(2);
      expect(stderr).toContain("every batch's reply failed to parse");
      expect(summaryOf(fake)).toBe(
        [
          "The review could not complete: the model's reply held no readable findings, twice.",
          "",
          "Nothing was reviewed on this run. Run the pipeline again to retry.",
        ].join("\n"),
      );
      expect(fake.statuses.at(-1)).toMatchObject({
        state: "FAILED",
        description:
          "Failed. The review could not complete: the model's reply held no readable findings, twice.",
      });
    } finally {
      await fake.close();
    }
  });
});

describe("a model call that fails", () => {
  it("posts the reason instead of dying in silence", async () => {
    const fake = await startFakeBitbucket();
    try {
      const failing: ModelPort = { complete: () => Promise.reject(new Error("throttled\nretry")) };
      const { code } = await reviewOnBitbucket(fake, consumerRepo(), failing);
      expect(code).toBe(1);
      expect(summaryOf(fake)).toContain(
        "The review could not complete: model call failed: throttled.",
      );
      expect(fake.statuses.at(-1)?.state).toBe("FAILED");
    } finally {
      await fake.close();
    }
  });

  it("still fails with the model's reason when even the failure cannot be posted", async () => {
    let stderr = "";
    const refuse = () => Promise.reject(new Error("host down\ntrace"));
    const code = await runCli(["review"], {
      cwd: consumerRepo(),
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/e2e",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "1",
        BITBUCKET_TOKEN: "t",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.reject(new Error("throttled")) },
      scmPort: {
        listInlineComments: refuse,
        createInlineComment: refuse,
        updateComment: refuse,
        deleteComment: refuse,
        listSummaryComments: refuse,
        createSummaryComment: refuse,
        updateSummaryComment: refuse,
        postStatus: refuse,
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("could not post the failure summary: host down\n");
    expect(stderr).toContain("model call failed: throttled");
  });
});

describe("lines at the reviewed commit", () => {
  it("reads HEAD, the index, the disk and then the diff", () => {
    const repo = consumerRepo();
    expect(linesAtHead(repo, "tests/smoke/homepage.spec.ts", undefined)?.[2]).toBe("test(");
    write(repo, "tests/smoke/homepage.spec.ts", "staged();\n");
    git(repo, "add", "-A");
    expect(linesAtHead(repo, "tests/smoke/homepage.spec.ts", undefined, true)?.[0]).toBe(
      "staged();",
    );
    const plain = mkdtempSync(path.join(tmpdir(), "peacock-plain-"));
    writeFileSync(path.join(plain, "a.ts"), "disk();\n");
    expect(linesAtHead(plain, "a.ts", undefined)?.[0]).toBe("disk();");
    expect(linesAtHead(plain, "b.ts", new Map([[2, "diff();"]]))).toEqual(["", "diff();"]);
    expect(linesAtHead(plain, "b.ts", undefined)).toBeUndefined();
  });
});

describe("summary comments on Bitbucket", () => {
  it("turns an earlier summary of ours clean instead of leaving it or adding one", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.comments.push({
        id: 70,
        content: { raw: "## Code review\n\n1 finding: 1 minor\n\n- **Minor** `axis-tags`" },
        user: { uuid: BOT_UUID },
      });
      const repo = consumerRepo();
      const finding = { ...WRONG_FINDING, quote: "    await home.open();", suggestion: undefined };
      await reviewOnBitbucket(
        fake,
        repo,
        scripted({ text: JSON.stringify({ findings: [finding] }) }).port,
      );
      expect(summaryOf(fake).split("\n")[0]).toBe("1 finding: 1 minor");
      await reviewOnBitbucket(fake, repo, scripted({ text: '{"findings": []}' }).port);
      const summaries = fake.comments.filter((comment) => comment.inline === undefined);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        id: 70,
        content: { raw: "No issues found in this change." },
      });
    } finally {
      await fake.close();
    }
  });
});

describe("one summary template", () => {
  it("says nothing in scope was changed when no reviewed file changed", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = consumerRepo();
      write(repo, "delta-peacock.config.yaml", "review:\n  include: ['pages/**']\n");
      commitAll(repo, "scope");
      const model = scripted({ text: '{"findings": []}' });
      await reviewOnBitbucket(fake, repo, model.port);
      expect(model.requests).toHaveLength(0);
      expect(summaryOf(fake)).toBe("");
      expect(fake.statuses.at(-1)?.description).toBe("Passed. No reviewable files in this change.");
      expect(fake.insightReport?.["details"]).toBe("Nothing in scope was changed.");
      // with summaryWhenClean the same template is posted as a comment
      write(
        repo,
        "delta-peacock.config.yaml",
        "review:\n  include: ['pages/**']\n  summaryWhenClean: true\n",
      );
      commitAll(repo, "summaries");
      await reviewOnBitbucket(fake, repo, model.port);
      expect(summaryOf(fake)).toBe("Nothing in scope was changed.");
    } finally {
      await fake.close();
    }
  });

  it("writes titles and bodies without dashes or citation filler", () => {
    expect(plainTitle("Missing feature tag — axis-tags", "axis-tags")).toBe("Missing feature tag");
    expect(plainTitle("Timeout – hard coded wait")).toBe("Timeout: hard coded wait");
    expect(plainBody("According to the guideline `axis-tags`, tag the test - once.")).toBe(
      "Tag the test, once.",
    );
    expect(plainBody("Keep `a - b` as it is.")).toBe("Keep `a - b` as it is.");
  });
});

describe("declared tags", () => {
  it("reads object keys from a TS config as text, never running it", () => {
    const index = objectKeysByPath(RUNNER_CONFIG);
    expect(keysAt(index, "tags.features")).toEqual(["checkout", "cart", "pdp-types"]);
    expect(keysAt(index, "sites")).toEqual(["EU", "US"]);
    expect(keysAt(index, "sites.*.locales")).toEqual(["de", "fr", "en"]);
    const tags = declaredTags(RUNNER_CONFIG, "test-runner.config.ts");
    expect(tags?.axis).toEqual(
      expect.arrayContaining([
        "@site:EU",
        "@not-site:US",
        "@env:stg",
        "@device:mobile",
        "@locales",
      ]),
    );
    expect(tags?.axis).toContain("@locale:fr");
  });

  it("finds a guideline's Good and Bad examples", () => {
    const { good, bad } = examplesOf(AXIS_TAGS);
    expect(good).toHaveLength(2);
    expect(bad).toHaveLength(1);
  });
});

describe("config from the target branch", () => {
  function configRepo(): string {
    const repo = makeRepo();
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: MAJOR\n");
    commitAll(repo, "config");
    git(repo, "checkout", "-q", "-b", "loosen");
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: none\n");
    commitAll(repo, "loosen the gate");
    return repo;
  }

  it("reads delta-peacock.config.yaml from the target the host names", () => {
    const repo = configRepo();
    const notices: string[] = [];
    const config = loadConfig({
      root: repo,
      env: { DELTA_PEACOCK_REVIEW_TARGET: "main" },
      onNotice: (notice) => notices.push(notice),
    });
    expect(config.gate.failOn).toBe("MAJOR");
    expect(notices).toContain("delta-peacock.config.yaml read from main");
    // one read per process: the second load neither fetches nor repeats the notice
    const again: string[] = [];
    const cached = loadConfig({
      root: repo,
      env: { DELTA_PEACOCK_REVIEW_TARGET: "main" },
      onNotice: (notice) => again.push(notice),
    });
    expect(cached.gate.failOn).toBe("MAJOR");
    expect(again).toEqual([]);
  });

  it("keeps the working tree without a host target, or when opted out", () => {
    const repo = configRepo();
    expect(loadConfig({ root: repo }).gate.failOn).toBe("none");
    expect(
      loadConfig({
        root: repo,
        env: { DELTA_PEACOCK_REVIEW_TARGET: "main", DELTA_PEACOCK_CONFIG_FROM: "source" },
      }).gate.failOn,
    ).toBe("none");
  });

  it("says so when the target cannot be read, and stays quiet outside git", () => {
    const repo = configRepo();
    const notices: string[] = [];
    const config = loadConfig({
      root: repo,
      env: { DELTA_PEACOCK_REVIEW_TARGET: "gone", DELTA_PEACOCK_REVIEW_FETCH_TARGET: "false" },
      onNotice: (notice) => notices.push(notice),
    });
    expect(config.gate.failOn).toBe("none");
    expect(notices).toEqual([
      "could not read gone; using delta-peacock.config.yaml from the working tree",
    ]);
    const outside = mkdtempSync(path.join(tmpdir(), "peacock-plain-"));
    const quiet: string[] = [];
    loadConfig({
      root: outside,
      env: { DELTA_PEACOCK_REVIEW_TARGET: "main" },
      onNotice: (notice) => quiet.push(notice),
    });
    expect(quiet).toEqual([]);
  });

  it("falls back to the working tree while the target has no config yet", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "setup");
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: MINOR\n");
    commitAll(repo, "set up the reviewer");
    const notices: string[] = [];
    const config = loadConfig({
      root: repo,
      env: { DELTA_PEACOCK_REVIEW_TARGET: "main" },
      onNotice: (notice) => notices.push(notice),
    });
    expect(config.gate.failOn).toBe("MINOR");
    expect(notices[0]).toContain("holds no delta-peacock.config.yaml");
  });
});
