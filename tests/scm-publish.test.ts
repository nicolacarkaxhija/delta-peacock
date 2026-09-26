import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { startFakeGitHub, type FakeGitHub } from "./helpers/fake-github.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

function makeScenario(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "add guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "add logging");
  return repo;
}

function model(text: string): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

const FINDING_WITH_SUGGESTION = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      quote: "console.log(name);",
      title: "Console call added",
      body: "Replace the console.log with the logger.",
      suggestion: "  logger.info(name);",
      guidelineQuote: "Use the logger instead.",
    },
  ],
});

async function reviewAgainst(
  fake: FakeGitHub,
  repo: string,
  responseText: string,
  ...extra: string[]
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const code = await runCli(["review", ...extra], {
    cwd: repo,
    env: {
      DELTA_PEACOCK_SCM_PROVIDER: "github",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
      GITHUB_TOKEN: "test-token",
    },
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: model(responseText),
  });
  return { code, stderr };
}

describe("publishing to github", () => {
  it("posts inline comment with suggestion block, summary and status", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      const { code, stderr } = await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION);
      expect(code).toBe(0);
      expect(stderr).toContain("published: 1 created");

      expect(fake.reviewComments).toHaveLength(1);
      const comment = fake.reviewComments[0];
      expect(comment?.path).toBe("src/app.js");
      expect(comment?.line).toBe(2);
      expect(comment?.body).toContain(
        `**Major** · [no-console](${fake.baseUrl}/acme/widgets/blob/main/guidelines/no-console.md)`,
      );
      expect(comment?.body).toContain("Replace the console.log with the logger.");
      expect(comment?.body).toContain("```suggestion");
      expect(comment?.body).toContain("logger.info(name);");
      // github hides html comments, so the marker still carries identity there
      expect(comment?.body).toContain("<!-- delta-peacock:finding:");

      expect(fake.issueComments).toHaveLength(1);
      const summary = fake.issueComments[0]?.body ?? "";
      expect(summary.startsWith("1 finding: 1 major\n")).toBe(true);
      expect(summary).toContain("in `src/app.js` line 2: Console call added");
      expect(summary).not.toContain("Blocked");
      expect(summary).toContain("<!-- delta-peacock:summary -->");

      expect(fake.statuses).toHaveLength(1);
      expect(fake.statuses[0]?.state).toBe("success"); // advisory
      expect(fake.statuses[0]?.description).toBe("1 finding, 1 major. See the comments.");
    } finally {
      await fake.close();
    }
  });

  it("re-runs update in place and resolve stale comments, never duplicating", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION);
      expect(fake.reviewComments).toHaveLength(1);
      const originalId = fake.reviewComments[0]?.id;

      // identical second run: nothing changes
      const second = await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION);
      expect(second.stderr).toContain("0 created, 0 updated, 0 resolved, 1 unchanged");
      expect(fake.reviewComments).toHaveLength(1);
      expect(fake.reviewComments[0]?.id).toBe(originalId);

      // same finding, different wording: updated in place
      const reworded = JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 2,
            quote: "console.log(name);",
            title: "Console call added",
            body: "New wording.",
            guidelineQuote: "Use the logger instead.",
          },
        ],
      });
      const third = await reviewAgainst(fake, repo, reworded);
      expect(third.stderr).toContain("0 created, 1 updated");
      expect(fake.reviewComments).toHaveLength(1);
      expect(fake.reviewComments[0]?.body).toContain("New wording.");

      // finding gone: comment kept as a trace of where it was resolved, summary updated
      const clean = JSON.stringify({ findings: [] });
      const fourth = await reviewAgainst(fake, repo, clean);
      expect(fourth.stderr).toContain("1 resolved");
      expect(fake.reviewComments).toHaveLength(1);
      expect(fake.reviewComments[0]?.body).toMatch(/Resolved in `[0-9a-f]{12}`/);
      // a later run leaves the trace alone
      const fifth = await reviewAgainst(fake, repo, clean);
      expect(fifth.stderr).toContain("0 created, 0 updated, 0 resolved, 0 unchanged");
      expect(fake.issueComments).toHaveLength(1);
      expect(fake.issueComments[0]?.body).toContain("No issues found in this change.");
    } finally {
      await fake.close();
    }
  });

  it("a later all-clear run resolves stale comments and turns the status green", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION, "--fail-on", "MAJOR");
      expect(fake.reviewComments).toHaveLength(1);
      expect(fake.statuses.at(-1)?.state).toBe("failure");

      // the next push leaves nothing to review against the target
      git(repo, "checkout", "-q", "main");
      git(repo, "-c", "user.name=f", "-c", "user.email=f@e", "merge", "-q", "--no-edit", "feature");
      git(repo, "checkout", "-q", "feature");
      const { code } = await reviewAgainst(
        fake,
        repo,
        FINDING_WITH_SUGGESTION,
        "--fail-on",
        "MAJOR",
      );
      expect(code).toBe(0);
      // stale finding resolved, its comment left as the trace
      expect(fake.reviewComments.map((comment) => comment.body)).toEqual([
        expect.stringContaining("Resolved in"),
      ]);
      expect(fake.statuses.at(-1)?.state).toBe("success");
    } finally {
      await fake.close();
    }
  });

  it("collapses two findings sharing a fingerprint into a single comment", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      const twin = JSON.stringify({
        findings: [
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 2,
            quote: "console.log(name);",
            title: "First",
            body: "a",
            guidelineQuote: "Use the logger instead.",
          },
          {
            guidelineId: "no-console",
            file: "src/app.js",
            line: 2,
            quote: "console.log(name);",
            title: "Second",
            body: "b",
            guidelineQuote: "Use the logger instead.",
          },
        ],
      });
      const { stderr } = await reviewAgainst(fake, repo, twin);
      expect(stderr).toContain("1 created");
      expect(fake.reviewComments).toHaveLength(1);
      // and the re-run stays stable
      const again = await reviewAgainst(fake, repo, twin);
      expect(again.stderr).toContain("0 created, 0 updated, 0 resolved, 1 unchanged");
    } finally {
      await fake.close();
    }
  });

  it("never deletes a human comment that quotes a marker", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      fake.reviewComments.push({
        id: 999,
        body: "I saw `<!-- delta-peacock:finding:aaaaaaaaaaaa -->` in the docs, neat!",
        path: "src/app.js",
        line: 1,
      });
      await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION);
      expect(fake.reviewComments.some((comment) => comment.id === 999)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("gate failure posts a failure status and still exits 2", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      const { code } = await reviewAgainst(
        fake,
        repo,
        FINDING_WITH_SUGGESTION,
        "--fail-on",
        "MAJOR",
      );
      expect(code).toBe(2);
      expect(fake.statuses[0]?.state).toBe("failure");
    } finally {
      await fake.close();
    }
  });

  it("skips the status when commit statuses are switched off", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      let stderr = "";
      const code = await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_SCM_COMMIT_STATUS: "false",
          GITHUB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: (text) => {
          stderr += text;
        },
        modelPort: model(FINDING_WITH_SUGGESTION),
      });
      expect(code).toBe(0);
      expect(stderr).toContain("published");
      expect(fake.statuses).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it("maps an unexpected status code to a plain tool error", async () => {
    const fake = await startFakeGitHub();
    try {
      const { createGitHubPort } = await import("../src/scm/github.js");
      const port = createGitHubPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      await expect(port.updateComment("99999", "x")).rejects.toThrow(/404/);
    } finally {
      await fake.close();
    }
  });

  it("a passed gate posts a success status with the counts", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      await reviewAgainst(fake, repo, FINDING_WITH_SUGGESTION, "--fail-on", "CRITICAL");
      expect(fake.statuses[0]?.state).toBe("success");
      expect(fake.statuses[0]?.description).toBe("1 finding, 1 major. See the comments.");
      expect(fake.statuses[0]?.context).toBe("Code review");
    } finally {
      await fake.close();
    }
  });

  it("a blocked gate names what must be resolved and points at the reviews doc", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      write(repo, "docs/reviews.md", "# Reviews\n");
      const { code } = await reviewAgainst(
        fake,
        repo,
        FINDING_WITH_SUGGESTION,
        "--fail-on",
        "MAJOR",
      );
      expect(code).toBe(2);
      const summary = fake.issueComments[0]?.body ?? "";
      expect(summary).toContain("**Blocked: a major finding must be resolved.**");
      expect(summary).toContain(
        `[docs/reviews.md](${fake.baseUrl}/acme/widgets/blob/main/docs/reviews.md)`,
      );
      expect(fake.statuses[0]?.description).toBe("1 finding, 1 major. See the comments.");
    } finally {
      await fake.close();
    }
  });

  it("uses the configured display name everywhere a reader looks", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      git(repo, "update-ref", "refs/remotes/origin/main", "main");
      await runCli(["review"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_REVIEW_DISPLAY_NAME: "Automated review",
          DELTA_PEACOCK_REVIEW_TARGET: "origin/main",
          GITHUB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: model(FINDING_WITH_SUGGESTION),
      });
      // the name lives in the status only; the summary opens with its verdict
      expect(fake.issueComments[0]?.body.startsWith("1 finding: 1 major\n")).toBe(true);
      expect(fake.issueComments[0]?.body).not.toContain("Automated review");
      expect(fake.statuses[0]?.context).toBe("Automated review");
      expect(fake.reviewComments[0]?.body).toContain("/blob/main/guidelines/no-console.md");
    } finally {
      await fake.close();
    }
  });

  it("dry run: zero requests of any kind reach the server", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      const { code, stderr } = await reviewAgainst(
        fake,
        repo,
        FINDING_WITH_SUGGESTION,
        "--dry-run",
        "--report",
        "dry.json",
      );
      expect(code).toBe(0);
      expect(stderr).toContain("dry run");
      expect(fake.writes).toHaveLength(0);
      expect(fake.reviewComments).toHaveLength(0);
      expect(fake.statuses).toHaveLength(0);
      // terminal and report outputs still produced
      const report = JSON.parse(readFileSync(path.join(repo, "dry.json"), "utf8")) as {
        findings: unknown[];
      };
      expect(report.findings).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("an injected scm port bypasses the http adapter entirely", async () => {
    const repo = makeScenario();
    const posted: string[] = [];
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: model(FINDING_WITH_SUGGESTION),
      scmPort: {
        listInlineComments: () => Promise.resolve([]),
        createInlineComment: (comment) => {
          posted.push(comment.body);
          return Promise.resolve();
        },
        updateComment: () => Promise.resolve(),
        deleteComment: () => Promise.resolve(),
        listSummaryComments: () => Promise.resolve([]),
        createSummaryComment: (body) => {
          posted.push(body);
          return Promise.resolve();
        },
        updateSummaryComment: () => Promise.resolve(),
        postStatus: () => Promise.resolve(),
      },
    });
    expect(code).toBe(0);
    expect(posted.length).toBeGreaterThan(0);
  });

  it("rejects the bitbucket provider until its adapter ships", async () => {
    const repo = makeScenario();
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
      modelPort: model(FINDING_WITH_SUGGESTION),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("bitbucket");
  });

  it("missing token is an actionable tool error", async () => {
    const repo = makeScenario();
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
      modelPort: model(FINDING_WITH_SUGGESTION),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("GITHUB_TOKEN");
  });

  it("requires repository and pull request once a provider is set", async () => {
    const repo = makeScenario();
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_SCM_PROVIDER: "github" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model(FINDING_WITH_SUGGESTION),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("scm.repository");
    expect(stderr).toContain("scm.pullRequest");
  });
});
