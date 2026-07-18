import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config/loader.js";
import { ToolError } from "../src/errors.js";
import { runCli } from "../src/index.js";
import { buildScmPort } from "../src/scm/build.js";
import { createGitLabPort } from "../src/scm/gitlab.js";
import { startFakeGitLab } from "./helpers/fake-gitlab.js";
import { runScmContract } from "./helpers/scm-contract.js";
import { commitAll, makeRepo, write } from "./helpers/git.js";

function portAgainst(baseUrl: string, token = "test-token", repository = "acme/widgets") {
  return createGitLabPort({ repository, pullRequest: 7, token, baseUrl });
}

const STATE_MAP: Record<string, string> = {
  success: "success",
  failed: "failure",
  pending: "pending",
};

runScmContract("gitlab", {
  async make() {
    const fake = await startFakeGitLab();
    return {
      port: portAgainst(fake.baseUrl),
      inline: () =>
        fake.notes
          .filter((note) => note.position !== undefined)
          .map((note) => ({
            id: note.id,
            body: note.body,
            ...(note.position
              ? { path: note.position.new_path, line: note.position.new_line }
              : {}),
          })),
      summaries: () =>
        fake.notes
          .filter((note) => note.position === undefined)
          .map((note) => ({ id: note.id, body: note.body })),
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

describe("gitlab adapter errors", () => {
  it("rejects a malformed repository up front", () => {
    expect(() => createGitLabPort({ repository: "nope", pullRequest: 1, token: "t" })).toThrow(
      ToolError,
    );
  });

  it.each([
    { token: "wrong", pattern: /GITLAB_TOKEN/ },
    { token: "forbidden", pattern: /api scope/ },
    { token: "rate-limited", pattern: /rate limit/ },
    { token: "teapot", pattern: /418/ },
  ])("maps $token to an actionable error", async ({ token, pattern }) => {
    const fake = await startFakeGitLab();
    try {
      await expect(portAgainst(fake.baseUrl, token).listInlineComments()).rejects.toThrow(pattern);
    } finally {
      await fake.close();
    }
  });
});

describe("gitlab specifics", () => {
  it("addresses nested subgroup projects as one encoded id", async () => {
    const fake = await startFakeGitLab();
    try {
      await portAgainst(fake.baseUrl, "test-token", "group/subgroup/widgets").postStatus(
        "success",
        "all clear",
      );
      expect(fake.projects).toEqual(["group%2Fsubgroup%2Fwidgets"]);
    } finally {
      await fake.close();
    }
  });

  it("anchors inline comments with the full diff_refs position", async () => {
    const fake = await startFakeGitLab();
    try {
      await portAgainst(fake.baseUrl).createInlineComment({
        body: "finding",
        path: "src/app.js",
        line: 3,
      });
      const position = fake.notes[0]?.position;
      expect(position).toMatchObject({
        position_type: "text",
        base_sha: "basesha1234567",
        head_sha: "headsha1234567",
        start_sha: "startsha123456",
        new_path: "src/app.js",
        new_line: 3,
      });
    } finally {
      await fake.close();
    }
  });

  it("fetches merge request metadata once across inline comments and statuses", async () => {
    const fake = await startFakeGitLab();
    try {
      const port = portAgainst(fake.baseUrl);
      await port.createInlineComment({ body: "a", path: "src/app.js", line: 1 });
      await port.postStatus("failure", "1 finding(s) at or above MAJOR");
      await port.postStatus("success", "second");
      expect(fake.metaFetches).toBe(1);
      expect(fake.statuses[0]?.sha).toBe("headsha1234567");
    } finally {
      await fake.close();
    }
  });

  it("fetches the host-computed raw diff", async () => {
    const fake = await startFakeGitLab();
    try {
      const diff = await portAgainst(fake.baseUrl).fetchPullRequestDiff?.();
      expect(diff).toContain("from the gitlab api diff");
    } finally {
      await fake.close();
    }
  });

  it("maps a failed diff request to a tool error", async () => {
    const fake = await startFakeGitLab();
    try {
      await expect(portAgainst(fake.baseUrl, "wrong").fetchPullRequestDiff?.()).rejects.toThrow(
        /401/,
      );
    } finally {
      await fake.close();
    }
  });
});

describe("build for gitlab", () => {
  function gitlabConfig(baseUrl?: string) {
    return loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "gitlab",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        ...(baseUrl !== undefined ? { DELTA_PEACOCK_SCM_BASE_URL: baseUrl } : {}),
      },
    });
  }

  it("constructs the port when GITLAB_TOKEN is present", () => {
    const port = buildScmPort(gitlabConfig(), { GITLAB_TOKEN: "t" });
    expect(typeof port.listInlineComments).toBe("function");
  });

  it("missing GITLAB_TOKEN is an actionable tool error", () => {
    expect(() => buildScmPort(gitlabConfig(), {})).toThrow(/GITLAB_TOKEN/);
  });
});

describe("gitlab end to end", () => {
  const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
  const CITED = JSON.stringify({
    findings: [
      { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Console", body: "b" },
    ],
  });

  it("publishes findings to a merge request through the adapter", async () => {
    const fake = await startFakeGitLab();
    try {
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      const { git } = await import("./helpers/git.js");
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "src/app.js", "function f() {\n  console.log('x');\n}\n");
      commitAll(repo, "change");

      const code = await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "gitlab",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          GITLAB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: { complete: () => Promise.resolve({ text: CITED }) },
      });
      expect(code).toBe(0);
      expect(fake.notes.some((note) => note.position !== undefined)).toBe(true);
      expect(fake.notes.some((note) => note.position === undefined)).toBe(true);
      expect(fake.statuses).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("dry run writes nothing through the gitlab adapter", async () => {
    const fake = await startFakeGitLab();
    try {
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      const { git } = await import("./helpers/git.js");
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "src/app.js", "console.log('x');\n");
      commitAll(repo, "change");

      const code = await runCli(["review", "--dry-run"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "gitlab",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          GITLAB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: { complete: () => Promise.resolve({ text: CITED }) },
      });
      expect(code).toBe(0);
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});

describe("init on gitlab ci", () => {
  it("plans the gitlab snippet when GITLAB_CI is set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-init-"));
    let stdout = "";
    const code = runInit(
      {
        cwd: dir,
        env: { GITLAB_CI: "true" },
        out: (text) => {
          stdout += text;
        },
        err: () => undefined,
      },
      { force: false },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("delta-peacock-gitlab-ci-snippet.yml");
  });
});
