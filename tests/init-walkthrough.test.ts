import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { makeRepo, write } from "./helpers/git.js";

function scriptedLines(lines: (string | null)[]): () => Promise<string | null> {
  const queue = [...lines];
  return () => Promise.resolve(queue.shift() ?? null);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], cwd: string, lines?: (string | null)[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    ...(lines ? { readLine: scriptedLines(lines) } : {}),
  });
  return { code, stdout, stderr };
}

function read(repo: string, relPath: string): string {
  return readFileSync(path.join(repo, relPath), "utf8");
}

describe("init --walkthrough", () => {
  it("an all-defaults session writes files byte-identical to plain init", async () => {
    const plain = makeRepo();
    await run(["init"], plain);
    const guided = makeRepo();
    const { code, stdout } = await run(["init", "--walkthrough"], guided, ["", "", "", "", "", ""]);
    expect(code).toBe(0);
    for (const relPath of [
      "delta-peacock.config.yaml",
      "guidelines/example-no-debug-logging.md",
      "delta-peacock-ci-snippet.txt",
    ]) {
      expect(read(guided, relPath)).toBe(read(plain, relPath));
    }
    expect(stdout).toContain("created delta-peacock.config.yaml");
    expect(stdout).toContain("next steps");
  });

  it("github plus a gate writes the workflow snippet and a gated config", async () => {
    const repo = makeRepo();
    const { code } = await run(["init", "--walkthrough"], repo, [
      "github",
      "",
      "MAJOR",
      "",
      "",
      "",
    ]);
    expect(code).toBe(0);
    const config = read(repo, "delta-peacock.config.yaml");
    expect(config).toContain("provider: anthropic");
    expect(config).toContain("failOn: MAJOR");
    expect(read(repo, ".github/workflows/delta-peacock.yml")).toContain("npx delta-peacock review");
    // the generated config resolves cleanly
    expect((await run(["config"], repo)).code).toBe(0);
  });

  it("bedrock plus a per-review cap prices the cost guard into the config", async () => {
    const repo = makeRepo();
    const { code } = await run(["init", "--walkthrough"], repo, [
      "",
      "bedrock",
      "   ",
      "",
      "0.25",
      "",
    ]);
    expect(code).toBe(0);
    const config = read(repo, "delta-peacock.config.yaml");
    expect(config).toContain("provider: bedrock");
    expect(config).toContain("maxPerReview: 0.25");
    // a whitespace-only line counts as accepting the default
    expect(config).toContain("failOn: none");
    expect((await run(["config"], repo)).code).toBe(0);
  });

  it("gitlab, no context and a custom guidelines directory land in the right files", async () => {
    const repo = makeRepo();
    const { code } = await run(["init", "--walkthrough"], repo, [
      "gitlab",
      "openrouter",
      "info",
      "none",
      "none",
      "team-rules",
    ]);
    expect(code).toBe(0);
    const config = read(repo, "delta-peacock.config.yaml");
    expect(config).toContain("provider: openrouter");
    // severities are accepted case-insensitively
    expect(config).toContain("failOn: INFO");
    expect(config).toContain("guidelinesDir: team-rules");
    expect(config).toContain("provider: none");
    expect(existsSync(path.join(repo, "team-rules/example-no-debug-logging.md"))).toBe(true);
    expect(read(repo, "delta-peacock-gitlab-ci-snippet.yml")).toContain("merge_request_event");
    expect((await run(["config"], repo)).code).toBe(0);
  });

  it("bitbucket, an openai-compatible host and layered context", async () => {
    const repo = makeRepo();
    const { code } = await run(["init", "--walkthrough"], repo, [
      "bitbucket",
      "openai-compatible",
      "advisory",
      "repo_map+agentic",
      "0",
      "",
    ]);
    expect(code).toBe(0);
    const config = read(repo, "delta-peacock.config.yaml");
    expect(config).toContain("provider: openai-compatible");
    expect(config).toContain("baseUrl:");
    expect(config).toContain("providers: [repo_map, agentic]");
    // an explicit zero cap means no cost section at all
    expect(config).not.toContain("cost:");
    expect(read(repo, "delta-peacock-pipelines-snippet.yml")).toContain("BITBUCKET_PR_ID");
    expect((await run(["config"], repo)).code).toBe(0);
  });

  it("invalid answers re-prompt with the valid options", async () => {
    const repo = makeRepo();
    const { code, stdout } = await run(["init", "--walkthrough"], repo, [
      "svn",
      "local",
      "gpt-5",
      "anthropic",
      "sometimes",
      "none",
      "vibes",
      "repo_map",
      "abc",
      "-1",
      "0.10",
      "/abs/rules",
      "../outside",
      "rules",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("local, github, gitlab or bitbucket");
    expect(stdout).toContain("anthropic, bedrock, openrouter or openai-compatible");
    expect(stdout).toContain("advisory, BLOCKER");
    expect(stdout).toContain("repo_map, repo_map+agentic or none");
    expect(stdout).toContain("none or a dollar amount");
    expect(stdout).toContain("relative directory");
    const config = read(repo, "delta-peacock.config.yaml");
    expect(config).toContain("failOn: none");
    expect(config).toContain("maxPerReview: 0.1");
    expect(config).toContain("guidelinesDir: rules");
    expect(existsSync(path.join(repo, "rules/example-no-debug-logging.md"))).toBe(true);
    expect(existsSync(path.join(repo, "delta-peacock-ci-snippet.txt"))).toBe(true);
  });

  it("end of input aborts without writing anything", async () => {
    const repo = makeRepo();
    const { code, stdout } = await run(["init", "--walkthrough"], repo, ["github", null]);
    expect(code).toBe(1);
    expect(stdout).toContain("nothing was written");
    expect(existsSync(path.join(repo, "delta-peacock.config.yaml"))).toBe(false);
    expect(existsSync(path.join(repo, ".github"))).toBe(false);
    expect(existsSync(path.join(repo, "guidelines"))).toBe(false);
  });

  it("keeps existing files unless --force is passed", async () => {
    const repo = makeRepo();
    write(repo, "delta-peacock.config.yaml", "gate:\n  failOn: MINOR\n");
    const kept = await run(["init", "--walkthrough"], repo, ["", "", "", "", "", ""]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain("kept    delta-peacock.config.yaml");
    expect(read(repo, "delta-peacock.config.yaml")).toContain("MINOR");

    const forced = await run(["init", "--walkthrough", "--force"], repo, [
      "",
      "bedrock",
      "",
      "",
      "",
      "",
    ]);
    expect(forced.code).toBe(0);
    expect(read(repo, "delta-peacock.config.yaml")).toContain("provider: bedrock");
  });
});
