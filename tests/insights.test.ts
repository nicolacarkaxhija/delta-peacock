import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { startFakeBitbucket, type FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINES = [
  "---\nid: no-console\nseverity: BLOCKER\n---\n# No console\n\nUse the logger.\n",
  "---\nid: no-todo\nseverity: MAJOR\n---\n# No TODO\n\nFile an issue instead.\n",
];

const REPLY = JSON.stringify({
  findings: [
    { guidelineId: "no-console", file: "src/app.js", line: 1, title: "Console", body: "b1" },
    { guidelineId: "no-todo", file: "src/app.js", line: 2, title: "Todo", body: "b2" },
  ],
});

const model: ModelPort = { complete: () => Promise.resolve({ text: REPLY }) };

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

function bitbucketEnv(fake: FakeBitbucket, extra: Record<string, string> = {}) {
  return {
    DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
    DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
    DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
    BITBUCKET_TOKEN: "test-token",
    ...extra,
  };
}

async function review(
  fake: FakeBitbucket,
  extra: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const code = await runCli(["review", ...args], {
    cwd: reviewedRepo(),
    env: bitbucketEnv(fake, extra),
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: model,
  });
  return { code, stderr };
}

describe("bitbucket code insights", () => {
  it("publishes a report card and annotations alongside comments", async () => {
    const fake = await startFakeBitbucket();
    try {
      const { code } = await review(fake, { DELTA_PEACOCK_GATE_FAIL_ON: "MAJOR" });
      expect(code).toBe(2);
      expect(fake.insightReport).toMatchObject({
        title: "Code review",
        report_type: "BUG",
        result: "FAILED",
        details:
          "2 findings: 1 blocker, 1 major. Blocked: 2 findings (1 blocker, 1 major) must be resolved.",
      });
      const data = fake.insightReport?.["data"] as { title: string; value: number }[];
      expect(data).toEqual([
        { title: "Findings", type: "NUMBER", value: 2 },
        { title: "Blocker", type: "NUMBER", value: 1 },
        { title: "Major", type: "NUMBER", value: 1 },
      ]);
      expect(fake.insightAnnotations[0]?.link).toBe(
        "https://bitbucket.org/acme/widgets/src/main/guidelines/no-console.md",
      );
      expect(fake.insightAnnotations.map((a) => a.severity)).toEqual(["CRITICAL", "MEDIUM"]);
      expect(fake.insightAnnotations[0]).toMatchObject({
        annotation_type: "CODE_SMELL",
        path: "src/app.js",
        line: 1,
      });
      expect(fake.insightAnnotations[0]?.external_id).toMatch(/^[0-9a-f]{12}$/);
      // comments stayed on by default
      expect(fake.comments.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });

  it("publishes by default on bitbucket, and an explicit false switches it off", async () => {
    const fake = await startFakeBitbucket();
    try {
      await review(fake, { DELTA_PEACOCK_REVIEW_DISPLAY_NAME: "Automated review" });
      expect(fake.insightReport?.["title"]).toBe("Automated review");
      expect(fake.statuses.at(-1)?.name).toBe("Automated review");
    } finally {
      await fake.close();
    }
    const off = await startFakeBitbucket();
    try {
      await review(off, { DELTA_PEACOCK_SCM_CODE_INSIGHTS: "false" });
      expect(off.insightReport).toBeUndefined();
    } finally {
      await off.close();
    }
  });

  it("re-runs upsert annotations by external id, never duplicating", async () => {
    const fake = await startFakeBitbucket();
    try {
      await review(fake);
      const afterFirst = fake.insightAnnotations.length;
      await review(fake);
      expect(fake.insightAnnotations.length).toBe(afterFirst);
    } finally {
      await fake.close();
    }
  });

  it("supports commentless publication: insights and status, no comments", async () => {
    const fake = await startFakeBitbucket();
    try {
      const { code } = await review(fake, { DELTA_PEACOCK_SCM_COMMENTS: "false" });
      expect(code).toBe(0);
      expect(fake.comments).toHaveLength(0);
      expect(fake.statuses).toHaveLength(1);
      expect(fake.insightAnnotations.length).toBeGreaterThan(0);
      expect(fake.insightReport?.["result"]).toBe("PASSED"); // advisory gate
    } finally {
      await fake.close();
    }
  });

  it("degrades with a notice when the workspace rejects insights", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.insightsDisabled = true;
      const { code, stderr } = await review(fake);
      expect(code).toBe(0); // the review itself is unharmed
      expect(stderr).toContain("code insights rejected");
      expect(fake.comments.length).toBeGreaterThan(0); // comments still landed
    } finally {
      await fake.close();
    }
  });

  it("a provider without insights says so instead of failing", async () => {
    const { startFakeGitHub } = await import("./helpers/fake-github.js");
    const fake = await startFakeGitHub();
    try {
      let stderr = "";
      const code = await runCli(["review"], {
        cwd: reviewedRepo(),
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_SCM_CODE_INSIGHTS: "true",
          GITHUB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: (text) => {
          stderr += text;
        },
        modelPort: model,
      });
      expect(code).toBe(0);
      expect(stderr).toContain("no code insights");
    } finally {
      await fake.close();
    }
  });

  it("dry run writes nothing, insights included", async () => {
    const fake = await startFakeBitbucket();
    try {
      const { code } = await review(fake, {}, ["--dry-run"]);
      expect(code).toBe(0);
      expect(fake.writes).toEqual([]);
      expect(fake.insightReport).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});
