import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { ciBuildUrl } from "../src/config/ci.js";
import { buildStatusFieldErrors, startFakeBitbucket } from "./helpers/fake-bitbucket.js";
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
          context: status.name,
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

describe("bitbucket source sha caching", () => {
  it("fetches the pull request once for consecutive statuses", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = portAgainst(fake.baseUrl);
      await port.postStatus("success", "first");
      await port.postStatus("failure", "second");
      expect(fake.statuses).toHaveLength(2);
      expect(fake.statuses[0]?.sha).toBe(fake.statuses[1]?.sha);
    } finally {
      await fake.close();
    }
  });
});

describe("bitbucket build status contract", () => {
  it("the fake enforces the real field rules", () => {
    expect(buildStatusFieldErrors({ key: "k", state: "SUCCESSFUL" })).toEqual({
      url: ["This field is required."],
    });
    expect(buildStatusFieldErrors({ key: "k", state: "FAILED", url: "/pipelines" })).toEqual({
      url: ["Enter a valid URL."],
    });
    expect(Object.keys(buildStatusFieldErrors({ state: "DONE", url: "https://x.y" }))).toEqual([
      "key",
      "state",
    ]);
    for (const state of ["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"]) {
      expect(buildStatusFieldErrors({ key: "k", state, url: "https://x.y/z" })).toEqual({});
    }
  });

  it("sends key, a valid state, an absolute url and the source branch", async () => {
    const fake = await startFakeBitbucket();
    try {
      await portAgainst(fake.baseUrl).postStatus("failure", "1 MAJOR");
      expect(fake.lastStatusBody).toEqual({
        key: "delta-peacock",
        name: "Code review",
        state: "FAILED",
        url: "https://bitbucket.org/acme/widgets/pull-requests/7",
        description: "1 MAJOR",
        refname: "feature/widgets",
      });
    } finally {
      await fake.close();
    }
  });

  it("links the pipeline run when one is given and ignores a relative one", async () => {
    const fake = await startFakeBitbucket();
    try {
      const run = "https://bitbucket.org/acme/widgets/pipelines/results/42";
      await createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
        statusUrl: run,
      }).postStatus("success", "clean");
      expect(fake.lastStatusBody?.["url"]).toBe(run);
      await createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
        statusUrl: "/pipelines/results/42",
      }).postStatus("success", "clean");
      expect(fake.lastStatusBody?.["url"]).toBe(
        "https://bitbucket.org/acme/widgets/pull-requests/7",
      );
    } finally {
      await fake.close();
    }
  });

  it("appends the error body to an unmapped status so a 400 names its fields", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: `${fake.baseUrl}/nowhere`,
      });
      await expect(port.postStatus("success", "x")).rejects.toThrow(/404 .*no route/);
    } finally {
      await fake.close();
    }
  });

  it("derives the pipeline url from Bitbucket's own variables only", () => {
    expect(
      ciBuildUrl({
        BITBUCKET_BUILD_NUMBER: "42",
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_REPO_SLUG: "widgets",
      }),
    ).toBe("https://bitbucket.org/acme/widgets/pipelines/results/42");
    expect(ciBuildUrl({ BITBUCKET_BUILD_NUMBER: "42" })).toBeUndefined();
    expect(
      ciBuildUrl({
        BITBUCKET_BUILD_NUMBER: "4 2",
        BITBUCKET_WORKSPACE: "acme",
        BITBUCKET_REPO_SLUG: "widgets",
      }),
    ).toBeUndefined();
    expect(ciBuildUrl({})).toBeUndefined();
  });
});

describe("build for bitbucket", () => {
  it("refuses to build a port for local mode", async () => {
    const { buildScmPort } = await import("../src/scm/build.js");
    const { loadConfig } = await import("../src/config/loader.js");
    expect(() => buildScmPort(loadConfig({ root: makeRepo() }), {})).toThrow(ToolError);
  });

  it("rethrows the git failure when the injected port cannot serve a diff", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/no-console.md",
      "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n",
    );
    commitAll(repo, "rules");
    git(repo, "branch", "-m", "main", "detached-work");
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.resolve({ text: '{"findings": []}' }) },
      scmPort: {
        listInlineComments: () => Promise.resolve([]),
        createInlineComment: () => Promise.resolve(),
        updateComment: () => Promise.resolve(),
        deleteComment: () => Promise.resolve(),
        listSummaryComments: () => Promise.resolve([]),
        createSummaryComment: () => Promise.resolve(),
        updateSummaryComment: () => Promise.resolve(),
        postStatus: () => Promise.resolve(),
        // note: no fetchPullRequestDiff
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("git");
  });

  it("constructs without a base url for production use", async () => {
    const { buildScmPort } = await import("../src/scm/build.js");
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
    });
    const port = buildScmPort(config, { BITBUCKET_TOKEN: "t" });
    expect(typeof port.listInlineComments).toBe("function");
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

  it("surfaces a malformed --last-reviewed-commit instead of silently using the SCM API diff", async () => {
    const fake = await startFakeBitbucket();
    try {
      fake.diffText = API_DIFF;
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "src/app.js", "console.log('x');\n");
      commitAll(repo, "change");

      let stderr = "";
      const code = await runCli(["review", "--last-reviewed-commit", "bad ref!"], {
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
        modelPort: model(CITED),
      });
      // an invalid ref is a configuration mistake; ADR 0004 reserves the SCM
      // API fallback for a shallow or absent local clone, not for this
      expect(code).toBe(1);
      expect(stderr).toContain("unsafe git ref name");
      expect(stderr).not.toContain("using the SCM API diff instead");
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
