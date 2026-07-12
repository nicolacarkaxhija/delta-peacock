import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { startFakeBitbucket } from "./helpers/fake-bitbucket.js";
import { runScmContract } from "./helpers/scm-contract.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

function portAgainst(baseUrl: string, token = "test-token") {
  return createBitbucketPort({
    repository: "acme/widgets",
    pullRequest: 7,
    token,
    baseUrl,
  });
}

const STATE_MAP: Record<string, string> = {
  SUCCESSFUL: "success",
  FAILED: "failure",
  INPROGRESS: "pending",
};

runScmContract("bitbucket", {
  async make() {
    const fake = await startFakeBitbucket();
    return {
      port: portAgainst(fake.baseUrl),
      inline: () =>
        fake.comments
          .filter((comment) => comment.inline !== undefined)
          .map((comment) => ({
            id: comment.id,
            body: comment.content.raw,
            ...(comment.inline ? { path: comment.inline.path, line: comment.inline.to } : {}),
          })),
      summaries: () =>
        fake.comments
          .filter((comment) => comment.inline === undefined)
          .map((comment) => ({ id: comment.id, body: comment.content.raw })),
      statuses: () =>
        fake.statuses.map((status) => ({
          state: STATE_MAP[status.state] ?? status.state,
          description: status.description,
          context: status.key,
          sha: status.sha,
        })),
      close: () => fake.close(),
    };
  },
});

describe("bitbucket adapter errors", () => {
  it("rejects a malformed repository up front", () => {
    expect(() => createBitbucketPort({ repository: "nope", pullRequest: 1, token: "t" })).toThrow(
      ToolError,
    );
  });

  it.each([
    { token: "wrong", pattern: /BITBUCKET_TOKEN/ },
    { token: "forbidden", pattern: /permissions/ },
    { token: "rate-limited", pattern: /rate limit/ },
    { token: "teapot", pattern: /418/ },
  ])("maps $token to an actionable error", async ({ token, pattern }) => {
    const fake = await startFakeBitbucket();
    try {
      await expect(portAgainst(fake.baseUrl, token).listInlineComments()).rejects.toThrow(pattern);
    } finally {
      await fake.close();
    }
  });
});

describe("github api diff", () => {
  it("fetches the host-computed diff through the accept header", async () => {
    const { createGitHubPort } = await import("../src/scm/github.js");
    const { startFakeGitHub } = await import("./helpers/fake-github.js");
    const fake = await startFakeGitHub();
    try {
      const port = createGitHubPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      const diff = await port.fetchPullRequestDiff?.();
      expect(diff).toContain("from the github api diff");
    } finally {
      await fake.close();
    }
  });

  it("maps a failed diff request to a tool error", async () => {
    const { createGitHubPort } = await import("../src/scm/github.js");
    const { startFakeGitHub } = await import("./helpers/fake-github.js");
    const fake = await startFakeGitHub();
    try {
      const port = createGitHubPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "wrong",
        baseUrl: fake.baseUrl,
      });
      await expect(port.fetchPullRequestDiff?.()).rejects.toThrow(/401/);
    } finally {
      await fake.close();
    }
  });
});

describe("api diff fallback", () => {
  const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
  const CITED = JSON.stringify({
    findings: [
      { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Console", body: "b" },
    ],
  });
  const API_DIFF = [
    "diff --git a/src/app.js b/src/app.js",
    "index 111..222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1 +1,2 @@",
    "+console.log('from the api diff');",
    "",
  ].join("\n");

  function model(text: string): ModelPort {
    return { complete: () => Promise.resolve({ text }) };
  }

  it("falls back to the host's PR diff when local git cannot serve one", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.diffText = API_DIFF;
      // a repo whose target branch does not exist locally (shallow-clone shape)
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      git(repo, "branch", "-m", "main", "detached-work");

      let stderr = "";
      let stdout = "";
      const code = await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          BITBUCKET_TOKEN: "test-token",
        },
        out: (text) => {
          stdout += text;
        },
        err: (text) => {
          stderr += text;
        },
        modelPort: model(CITED),
      });
      expect(code).toBe(0);
      expect(stderr).toContain("using the SCM API diff instead");
      expect(stderr).toContain("degrade");
      expect(stdout).toContain("[no-console]");
      // the finding got published through the same adapter
      expect(fake.comments.some((comment) => comment.inline !== undefined)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("missing token for bitbucket is an actionable tool error", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "change\n");
    commitAll(repo, "change");
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model(CITED),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("BITBUCKET_TOKEN");
  });

  it("applies the size ceiling to the api diff too", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.diffText = `diff --git a/big.js b/big.js\n+${"x".repeat(4000)}\n`;
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      git(repo, "branch", "-m", "main", "detached-work");
      let stdout = "";
      const code = await runCli(["review", "--max-diff-bytes", "100"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          BITBUCKET_TOKEN: "test-token",
        },
        out: (text) => {
          stdout += text;
        },
        err: () => undefined,
        modelPort: model(CITED),
      });
      expect(code).toBe(0);
      expect(stdout).toContain("review skipped");
    } finally {
      await fake.close();
    }
  });

  it("still fails hard in local mode when git cannot diff", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "branch", "-m", "main", "detached-work");
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model(CITED),
    });
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
