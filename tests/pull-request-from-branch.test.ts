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

const FINDING = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      quote: "console.log(name);",
      title: "Console call added",
      body: "Replace the console.log with the logger.",
      guidelineQuote: "Use the logger instead.",
    },
  ],
});

function makeScenario(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "add guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "add logging");
  return repo;
}

function model(): ModelPort {
  return { complete: () => Promise.resolve({ text: FINDING }) };
}

async function run(
  repo: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const code = await runCli(args, {
    cwd: repo,
    env,
    out: () => undefined,
    err: (text) => {
      stderr += text;
    },
    modelPort: model(),
  });
  return { code, stderr };
}

function githubEnv(fake: FakeGitHub): Record<string, string> {
  return {
    DELTA_PEACOCK_SCM_PROVIDER: "github",
    DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
    DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
    GITHUB_TOKEN: "test-token",
  };
}

describe("runs without a pull request number", () => {
  it.each([[["config"]], [["guidelines", "lint"]]])(
    "%j runs under the github provider and asks the host nothing",
    async (args) => {
      const fake = await startFakeGitHub();
      try {
        const { code, stderr } = await run(makeScenario(), args, githubEnv(fake));
        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(fake.pullLookups).toEqual([]);
      } finally {
        await fake.close();
      }
    },
  );

  it("a review publishes to the open pull request of the branch", async () => {
    const fake = await startFakeGitHub();
    try {
      fake.openPulls.push({ number: 7, head: "acme:feature" });
      const { code, stderr } = await run(makeScenario(), ["review"], githubEnv(fake));
      expect(code).toBe(0);
      expect(stderr).toContain("published: 1 created");
      expect(fake.pullLookups).toContain("acme:feature");
      expect(fake.reviewComments).toHaveLength(1);
      expect(fake.statuses.map((status) => status.state)).toEqual(["success"]);
    } finally {
      await fake.close();
    }
  });

  it("a review on a branch with no open pull request says so, publishes nothing and keeps the gate", async () => {
    const fake = await startFakeGitHub();
    try {
      const { code, stderr } = await run(makeScenario(), ["review", "--fail-on", "MAJOR"], {
        ...githubEnv(fake),
      });
      expect(code).toBe(2);
      expect(stderr).toContain("no pull request for this branch: feature; nothing published");
      expect(fake.writes).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it.each([
    ["github on a detached HEAD", "github", true],
    ["gitlab on a branch", "gitlab", false],
  ])("a review with %s still needs the pull request number", async (_label, provider, detach) => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeScenario();
      if (detach) git(repo, "checkout", "-q", "--detach");
      const { code, stderr } = await run(repo, ["review"], {
        ...githubEnv(fake),
        DELTA_PEACOCK_SCM_PROVIDER: provider,
        GITLAB_TOKEN: "test-token",
      });
      expect(code).toBe(1);
      expect(stderr).toContain(`scm.pullRequest is required when scm.provider is ${provider}`);
      expect(fake.pullLookups).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
