import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_END,
  DESCRIPTION_START,
  upsertDescription,
  upsertDescriptionSection,
  VISIBLE_DESCRIPTION_END,
  VISIBLE_DESCRIPTION_START,
} from "../src/review/describe.js";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { createGitLabPort } from "../src/scm/gitlab.js";
import { createBitbucketPort } from "../src/scm/bitbucket.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { startFakeGitLab } from "./helpers/fake-gitlab.js";
import { startFakeBitbucket } from "./helpers/fake-bitbucket.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const REPLY = JSON.stringify({
  title: "feat: greet formally",
  summary: "Adds a formal flag to greet.",
});

function model(text = REPLY): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

function repoWithChange(): string {
  const repo = makeRepo();
  write(repo, "README.md", "hello\n");
  commitAll(repo, "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name, formal) {}\n");
  commitAll(repo, "change greet");
  return repo;
}

function githubEnv(baseUrl: string): Record<string, string> {
  return {
    DELTA_PEACOCK_SCM_PROVIDER: "github",
    DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
    DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    DELTA_PEACOCK_SCM_BASE_URL: baseUrl,
    GITHUB_TOKEN: "test-token",
  };
}

describe("upsertDescriptionSection", () => {
  it("appends a fenced section after the author's prose", () => {
    const result = upsertDescriptionSection("my own words", "summary");
    expect(result.startsWith("my own words\n\n")).toBe(true);
    expect(result).toContain(`${DESCRIPTION_START}\nsummary\n${DESCRIPTION_END}`);
  });

  it("replaces only the fenced section on re-run", () => {
    const first = upsertDescriptionSection("prose above", "v1");
    const withTail = `${first}\n\nprose below`;
    const second = upsertDescriptionSection(withTail, "v2");
    expect(second).toContain("prose above");
    expect(second).toContain("prose below");
    expect(second).toContain("v2");
    expect(second).not.toContain("v1");
    expect(second.match(new RegExp(DESCRIPTION_START, "g"))).toHaveLength(1);
  });

  it("stands alone when the description was empty", () => {
    expect(upsertDescriptionSection("  ", "s").startsWith(DESCRIPTION_START)).toBe(true);
  });

  it("uses a visible heading and footer without markers and replaces only that", () => {
    const first = upsertDescription("### Change summary\n\nthe author's own", "v1", false);
    expect(first.replaced).toBe(false);
    expect(first.body).not.toContain("<!--");
    expect(first.body).toContain(
      `${VISIBLE_DESCRIPTION_START}\n\nv1\n\n${VISIBLE_DESCRIPTION_END}`,
    );
    const second = upsertDescription(`${first.body}\n\nprose below`, "v2", false);
    expect(second.replaced).toBe(true);
    expect(second.body).toBe(
      `### Change summary\n\nthe author's own\n\n${VISIBLE_DESCRIPTION_START}\n\nv2\n\n${VISIBLE_DESCRIPTION_END}\n\nprose below`,
    );
  });

  it("turns a marker-fenced section into the visible one", () => {
    const legacy = upsertDescriptionSection("prose", "old");
    const next = upsertDescription(legacy, "new", false);
    expect(next).toEqual({
      body: `prose\n\n${VISIBLE_DESCRIPTION_START}\n\nnew\n\n${VISIBLE_DESCRIPTION_END}`,
      replaced: true,
    });
  });
});

describe("describe command", () => {
  it("prints the section in local mode and writes nothing", async () => {
    let stdout = "";
    const code = await runCli(["describe", "--title"], {
      cwd: repoWithChange(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: model(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain(DESCRIPTION_START);
    expect(stdout).toContain("Adds a formal flag");
    expect(stdout).toContain("title (local mode, not written)");
  });

  it("adds the section to the description, preserving author prose", async () => {
    const fake = await startFakeGitHub();
    try {
      const code = await runCli(["describe"], {
        cwd: repoWithChange(),
        env: githubEnv(fake.baseUrl),
        out: () => undefined,
        err: () => undefined,
        modelPort: model(),
      });
      expect(code).toBe(0);
      expect(fake.prText.body.startsWith("author prose\n\n")).toBe(true);
      expect(fake.prText.body).toContain("Adds a formal flag");
      expect(fake.prText.title).toBe("original title"); // untouched without --title
    } finally {
      await fake.close();
    }
  });

  it("re-running replaces the section instead of stacking a second one", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = repoWithChange();
      const run = (reply: string) =>
        runCli(["describe"], {
          cwd: repo,
          env: githubEnv(fake.baseUrl),
          out: () => undefined,
          err: () => undefined,
          modelPort: model(reply),
        });
      await run(JSON.stringify({ summary: "first version" }));
      await run(JSON.stringify({ summary: "second version" }));
      expect(fake.prText.body).toContain("second version");
      expect(fake.prText.body).not.toContain("first version");
      expect(fake.prText.body.match(new RegExp(DESCRIPTION_START, "g"))).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("writes a markerless section on bitbucket and replaces it on re-run", async () => {
    const fake = await startFakeBitbucket();
    try {
      const repo = repoWithChange();
      fake.prText.body = upsertDescriptionSection("author prose", "from 0.1.5");
      const env = {
        DELTA_PEACOCK_SCM_PROVIDER: "bitbucket",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
        BITBUCKET_TOKEN: "test-token",
      };
      let stdout = "";
      const run = (reply: string) =>
        runCli(["describe"], {
          cwd: repo,
          env,
          out: (text) => {
            stdout += text;
          },
          err: () => undefined,
          modelPort: model(reply),
        });
      expect(await run(JSON.stringify({ summary: "first version" }))).toBe(0);
      expect(stdout).toContain("description section updated");
      expect(await run(JSON.stringify({ summary: "second version" }))).toBe(0);
      expect(fake.prText.body).toBe(
        `author prose\n\n${VISIBLE_DESCRIPTION_START}\n\nsecond version\n\n${VISIBLE_DESCRIPTION_END}`,
      );

      stdout = "";
      await runCli(["describe", "--dry-run"], {
        cwd: repo,
        env,
        out: (text) => {
          stdout += text;
        },
        err: () => undefined,
        modelPort: model(),
      });
      expect(stdout).toContain(VISIBLE_DESCRIPTION_START);
      expect(stdout).not.toContain("<!--");
    } finally {
      await fake.close();
    }
  });

  it("sets the title only when asked", async () => {
    const fake = await startFakeGitHub();
    try {
      const code = await runCli(["describe", "--title"], {
        cwd: repoWithChange(),
        env: githubEnv(fake.baseUrl),
        out: () => undefined,
        err: () => undefined,
        modelPort: model(),
      });
      expect(code).toBe(0);
      expect(fake.prText.title).toBe("feat: greet formally");
    } finally {
      await fake.close();
    }
  });

  it("dry run performs the model call but never writes", async () => {
    const fake = await startFakeGitHub();
    try {
      const code = await runCli(["describe", "--dry-run"], {
        cwd: repoWithChange(),
        env: githubEnv(fake.baseUrl),
        out: () => undefined,
        err: () => undefined,
        modelPort: model(),
      });
      expect(code).toBe(0);
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("reports nothing to describe on an unchanged branch", async () => {
    const repo = makeRepo();
    write(repo, "README.md", "hello\n");
    commitAll(repo, "base");
    git(repo, "checkout", "-q", "-b", "feature");
    let stdout = "";
    const code = await runCli(["describe"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: model(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to describe");
  });

  it("is blocked by the cost guard before any model call", async () => {
    let called = 0;
    const counting: ModelPort = {
      complete() {
        called += 1;
        return Promise.resolve({ text: REPLY });
      },
    };
    let stdout = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
        // an unreachable cost explorer degrades to the counter with a notice
        DELTA_PEACOCK_COST_MONTHLY_CAP: "0.000001",
        DELTA_PEACOCK_COST_SPEND_SOURCE: "aws-cost-explorer",
      },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: counting,
    });
    expect(code).toBe(1);
    expect(called).toBe(0);
    expect(stdout).toContain("blocked by the cost guard");
  });

  it("skips when the diff exceeds the size ceiling", async () => {
    let stdout = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: { DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "10" },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: model(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("describe skipped");
  });

  it("honors --target explicitly", async () => {
    let stdout = "";
    const code = await runCli(["describe", "--target", "main"], {
      cwd: repoWithChange(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: model(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain(DESCRIPTION_START);
  });

  it("wraps a model transport failure into a tool error", async () => {
    let stderr = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.reject(new Error("socket hangup")) },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("model call failed");
  });

  it("passes a tool error from the model port through untouched", async () => {
    const { ToolError } = await import("../src/errors.js");
    let stderr = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.reject(new ToolError("credentials missing")) },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("credentials missing");
    expect(stderr).not.toContain("model call failed");
  });

  it("a JSON reply that is not an object is a tool error", async () => {
    let stderr = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model("```\n123\n```"),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("not a JSON object");
  });

  it("records priced usage to the spend counter", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-counter-")), "spend.json");
    const priced: ModelPort = {
      complete: () =>
        Promise.resolve({ text: REPLY, usage: { inputTokens: 100, outputTokens: 50 } }),
    };
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        DELTA_PEACOCK_COST_COUNTER_PATH: counter,
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: priced,
    });
    expect(code).toBe(0);
    expect(existsSync(counter)).toBe(true);
  });

  it("falls back to the default counter location when none is configured", async () => {
    const priced: ModelPort = {
      complete: () => Promise.resolve({ text: REPLY, usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "0.000001",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "0.000001",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: priced,
    });
    expect(code).toBe(0);
  });

  it("an injected SCM without description support is an actionable error", async () => {
    let stderr = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        GITHUB_TOKEN: "test-token",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model(),
      scmPort: {
        listInlineComments: () => Promise.resolve([]),
        createInlineComment: () => Promise.resolve(),
        updateComment: () => Promise.resolve(),
        deleteComment: () => Promise.resolve(),
        listSummaryComments: () => Promise.resolve([]),
        createSummaryComment: () => Promise.resolve(),
        updateSummaryComment: () => Promise.resolve(),
        postStatus: () => Promise.resolve(),
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("cannot edit descriptions");
  });

  it("builds the real model port when none is injected, still behind the guard", async () => {
    let stdout = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {
        ANTHROPIC_API_KEY: "fake-key-never-used",
        DELTA_PEACOCK_MODEL_ID: "claude-test-model",
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
      },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
    });
    expect(code).toBe(1); // blocked before any network call
    expect(stdout).toContain("blocked by the cost guard");
  });

  it("a reply without a summary is a tool error", async () => {
    let stderr = "";
    const code = await runCli(["describe"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model('{"title": "only a title"}'),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("summary");
  });
});

describe("pull request text on the other adapters", () => {
  it("gitlab reads and updates the MR text", async () => {
    const fake = await startFakeGitLab();
    try {
      const port = createGitLabPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      expect(await port.getPullRequestText?.()).toEqual({
        title: "original title",
        body: "author prose",
      });
      await port.updatePullRequestText?.({ body: "new body", title: "new title" });
      expect(fake.prText).toEqual({ title: "new title", body: "new body" });
    } finally {
      await fake.close();
    }
  });

  it("bitbucket keeps the current title when only the body changes", async () => {
    const fake = await startFakeBitbucket();
    try {
      const port = createBitbucketPort({
        repository: "acme/widgets",
        pullRequest: 7,
        token: "test-token",
        baseUrl: fake.baseUrl,
      });
      await port.updatePullRequestText?.({ body: "new body" });
      expect(fake.prText).toEqual({ title: "original title", body: "new body" });
    } finally {
      await fake.close();
    }
  });
});
