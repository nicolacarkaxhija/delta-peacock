import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import { commitAll, makeRepo, write } from "./helpers/git.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    env,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

describe("doctor", () => {
  it("passes a healthy local-mode setup, warning about the unset model id", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { code, stdout } = await run(["doctor"], repo);
    expect(code).toBe(0);
    expect(stdout).toContain("ok    config");
    expect(stdout).toContain("ok    git");
    expect(stdout).toContain("ok    guidelines");
    expect(stdout).toContain("warn  model");
    expect(stdout).toContain("local mode");
    expect(stdout).toContain("all checks passed");
  });

  it("fails with remedies when the setup is broken", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/broken.md", "---\nseverity: MAJOR\n---\nno id\n");
    const { code, stdout, stderr } = await run(["doctor"], repo, {
      DELTA_PEACOCK_MODEL_ID: "claude-test",
    });
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  guidelines");
    expect(stdout).toContain("FAIL  model");
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stderr).toContain("problem(s)");
  });

  it("reports a healthy model when id and credentials are present", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { code, stdout } = await run(["doctor"], repo, {
      DELTA_PEACOCK_MODEL_ID: "claude-test",
      ANTHROPIC_API_KEY: "k",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ok    model");
  });

  it("fails the git check outside a repository", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "peacock-nogit-"));
    write(dir, "guidelines/no-console.md", GUIDELINE);
    const { code, stdout } = await run(["doctor"], dir);
    expect(code).toBe(1);
    expect(stdout).toContain("not a git repository");
  });

  it("fails the git check when no merge base exists for the target", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { git } = await import("./helpers/git.js");
    git(repo, "branch", "-m", "main", "elsewhere");
    const { code, stdout } = await run(["doctor"], repo);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  git");
    expect(stdout).toContain("merge base");
  });

  it("warns when the guidelines directory holds nothing usable yet", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/.gitkeep", "");
    commitAll(repo, "empty dir");
    const { code, stdout } = await run(["doctor"], repo);
    expect(code).toBe(0);
    expect(stdout).toContain("warn  guidelines");
  });

  it("fails the guidelines check when the directory is missing", async () => {
    const repo = makeRepo();
    const { code, stdout } = await run(["doctor"], repo);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  guidelines");
    expect(stdout).toContain("not found");
  });

  it("fails on unresolvable configuration and skips the rest", async () => {
    const repo = makeRepo();
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: WHENEVER\n");
    const { code, stdout } = await run(["doctor"], repo);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  config");
    expect(stdout).toContain("skipped until the configuration resolves");
  });

  it("probes a configured scm read-only and reports reachability", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      const { code, stdout } = await run(["doctor"], repo, {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
        GITHUB_TOKEN: "test-token",
      });
      expect(code).toBe(0);
      expect(stdout).toContain("ok    scm");
      expect(fake.writes).toHaveLength(0); // read-only probe
    } finally {
      await fake.close();
    }
  });

  it("fails the scm check when an injected port cannot read", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    let stdout = "";
    const code = await runCli(["doctor"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
      },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      scmPort: {
        listInlineComments: () => Promise.resolve([]),
        createInlineComment: () => Promise.resolve(),
        updateComment: () => Promise.resolve(),
        deleteComment: () => Promise.resolve(),
        listSummaryComments: () => Promise.reject(new Error("network unreachable")),
        createSummaryComment: () => Promise.resolve(),
        updateSummaryComment: () => Promise.resolve(),
        postStatus: () => Promise.resolve(),
      },
    });
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  scm");
    expect(stdout).toContain("network unreachable");
  });

  it("fails the scm check with the adapter's actionable message", async () => {
    const fake = await startFakeGitHub();
    try {
      const repo = makeRepo();
      write(repo, "guidelines/no-console.md", GUIDELINE);
      commitAll(repo, "rules");
      const { code, stdout } = await run(["doctor"], repo, {
        DELTA_PEACOCK_SCM_PROVIDER: "github",
        DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
        DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
        DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
        GITHUB_TOKEN: "wrong",
      });
      expect(code).toBe(1);
      expect(stdout).toContain("FAIL  scm");
      expect(stdout).toContain("GITHUB_TOKEN");
    } finally {
      await fake.close();
    }
  });
});

describe("init", () => {
  it("scaffolds config, guideline and a generic ci snippet with next steps", async () => {
    const repo = makeRepo();
    const { code, stdout } = await run(["init"], repo);
    expect(code).toBe(0);
    expect(stdout).toContain("created delta-peacock.config.yaml");
    expect(stdout).toContain("created guidelines/example-no-debug-logging.md");
    expect(stdout).toContain("created delta-peacock-ci-snippet.txt");
    expect(stdout).toContain("next steps");
    expect(existsSync(path.join(repo, "delta-peacock.config.yaml"))).toBe(true);
  });

  it("writes a github workflow when running under github actions", async () => {
    const repo = makeRepo();
    const { code, stdout } = await run(["init"], repo, { GITHUB_ACTIONS: "true" });
    expect(code).toBe(0);
    expect(stdout).toContain(".github/workflows/delta-peacock.yml");
    expect(readFileSync(path.join(repo, ".github/workflows/delta-peacock.yml"), "utf8")).toContain(
      "npx delta-peacock review",
    );
  });

  it("writes platform snippets for bitbucket pipelines and jenkins", async () => {
    const bb = await run(["init"], makeRepo(), { BITBUCKET_BUILD_NUMBER: "12" });
    expect(bb.stdout).toContain("delta-peacock-pipelines-snippet.yml");
    const jenkins = await run(["init"], makeRepo(), { JENKINS_URL: "http://jenkins.local" });
    expect(jenkins.stdout).toContain("delta-peacock-jenkinsfile-snippet.groovy");
  });

  it("treats a missing key for an openai-compatible host as a warning only", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { code, stdout } = await run(["doctor"], repo, {
      DELTA_PEACOCK_MODEL_PROVIDER: "openai-compatible",
      DELTA_PEACOCK_MODEL_ID: "local-model",
      DELTA_PEACOCK_MODEL_BASE_URL: "http://localhost:11434/v1",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("warn  model");
    expect(stdout).toContain("fine for local hosts");
  });

  it("never overwrites existing files without --force", async () => {
    const repo = makeRepo();
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: MAJOR\n");
    const { code, stdout } = await run(["init"], repo);
    expect(code).toBe(0);
    expect(stdout).toContain("kept    delta-peacock.config.yaml");
    expect(readFileSync(path.join(repo, "delta-peacock.config.yaml"), "utf8")).toContain("MAJOR");

    const forced = await run(["init", "--force"], repo);
    expect(forced.code).toBe(0);
    expect(readFileSync(path.join(repo, "delta-peacock.config.yaml"), "utf8")).toContain(
      "provider: anthropic",
    );
  });

  it("produces a setup that immediately passes doctor and guidelines lint", async () => {
    const repo = makeRepo();
    await run(["init"], repo);
    commitAll(repo, "scaffold");
    const doctor = await run(["doctor"], repo);
    expect(doctor.code).toBe(0);
    const lint = await run(["guidelines", "lint"], repo);
    expect(lint.code).toBe(0);
    expect(lint.stdout).toContain("1 usable");
  });
});
