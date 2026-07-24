import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

/** An observations-only reply proposing one guideline. */
const OBSERVATIONS = JSON.stringify({
  findings: [
    {
      file: "src/app.js",
      line: 1,
      title: "Console call in committed code",
      body: "Route logging through the project logger.",
      severity: "MINOR",
      proposedGuideline: {
        id: "no-console",
        severity: "MAJOR",
        rationale: "Recurring console.log calls should be a codified rule.",
      },
    },
    {
      file: "src/app.js",
      line: 2,
      title: "A plain observation with no proposal",
      body: "Nothing to codify here.",
      severity: "INFO",
    },
  ],
});

function model(text: string): ModelPort {
  return { complete: () => Promise.resolve({ text }) };
}

/** An empty-corpus repo (the guidelines directory holds no rules yet). */
function bareRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/.keep", "");
  commitAll(repo, "empty corpus");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\nconst y = 1;\n");
  commitAll(repo, "change");
  return repo;
}

async function run(
  cwd: string,
  args: string[],
  port: ModelPort,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    modelPort: port,
  });
  return { code, stdout, stderr };
}

describe("review --bootstrap", () => {
  it("still refuses an empty corpus without the flag", async () => {
    const { code, stdout } = await run(bareRepo(), ["review"], model(OBSERVATIONS));
    expect(code).toBe(0);
    expect(stdout).toContain("no usable guidelines found");
  });

  it("proposes guideline drafts from an observations-only run, never gating", async () => {
    const repo = bareRepo();
    const { code, stdout } = await run(
      repo,
      ["review", "--bootstrap", "--fail-on", "MAJOR"],
      model(OBSERVATIONS),
    );
    expect(code).toBe(0); // bootstrap never gates, even with --fail-on
    expect(stdout).toContain("bootstrap: 2 observation(s), 1 guideline draft(s)");
    const draft = path.join(repo, "guidelines-drafts", "no-console.md");
    expect(existsSync(draft)).toBe(true);
    const content = readFileSync(draft, "utf8");
    expect(content).toContain("id: no-console");
    expect(content).toContain("severity: MAJOR");
    expect(content).toContain("## Rationale");
    expect(content).toContain("Recurring console.log calls");
    // it is a loader-valid guideline
    const lint = await run(
      repo,
      ["guidelines", "lint", "--guidelines-dir", "guidelines-drafts"],
      model("{}"),
    );
    expect(lint.code).toBe(0);
  });

  it("posts nothing to an SCM in bootstrap mode", async () => {
    const { startFakeGitHub } = await import("./helpers/fake-github.js");
    const fake = await startFakeGitHub();
    try {
      const repo = bareRepo();
      const code = await runCli(["review", "--bootstrap"], {
        cwd: repo,
        env: {
          DELTA_PEACOCK_SCM_PROVIDER: "github",
          DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
          DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
          DELTA_PEACOCK_SCM_BASE_URL: fake.baseUrl,
          GITHUB_TOKEN: "test-token",
        },
        out: () => undefined,
        err: () => undefined,
        modelPort: model(OBSERVATIONS),
      });
      expect(code).toBe(0);
      expect(fake.writes).toEqual([]); // nothing published
    } finally {
      await fake.close();
    }
  });

  it("is idempotent: a re-run overwrites the same draft", async () => {
    const repo = bareRepo();
    await run(repo, ["review", "--bootstrap"], model(OBSERVATIONS));
    await run(repo, ["review", "--bootstrap"], model(OBSERVATIONS));
    expect(readdirSync(path.join(repo, "guidelines-drafts"))).toEqual(["no-console.md"]);
  });

  it("honors a custom drafts directory", async () => {
    const repo = bareRepo();
    await run(repo, ["review", "--bootstrap", "--drafts-dir", "proposals"], model(OBSERVATIONS));
    expect(existsSync(path.join(repo, "proposals", "no-console.md"))).toBe(true);
  });

  it("works even when no guidelines directory exists at all", async () => {
    const repo = makeRepo(); // no guidelines directory whatsoever
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "console.log('x');\n");
    commitAll(repo, "change");
    const { code, stdout } = await run(repo, ["review", "--bootstrap"], model(OBSERVATIONS));
    expect(code).toBe(0);
    expect(stdout).toContain("guideline draft(s)");
  });
});

describe("init --starter", () => {
  /** A local pack the starter can resolve as a plain directory. */
  function starterPack(): string {
    const dir = makeRepo();
    write(dir, "pack.yaml", "name: starter\nversion: 0.1.0\ndescription: a starter set\n");
    write(
      dir,
      "no-console.md",
      "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n",
    );
    write(
      dir,
      "no-todo.md",
      "---\nid: no-todo\nseverity: MINOR\n---\n# No TODO\n\nFile an issue instead.\n",
    );
    return dir;
  }

  it("seeds the guidelines directory from a curated pack", async () => {
    const pack = starterPack();
    const repo = makeRepo();
    const { code, stdout } = await run(repo, ["init", "--starter", pack], model("{}"));
    expect(code).toBe(0);
    expect(stdout).toContain("starter pack starter: seeding 2 guideline(s)");
    expect(existsSync(path.join(repo, "guidelines", "no-console.md"))).toBe(true);
    expect(existsSync(path.join(repo, "guidelines", "no-todo.md"))).toBe(true);
    expect(existsSync(path.join(repo, "delta-peacock.config.yaml"))).toBe(true);
    // the seeded guidelines are loader-valid
    const lint = await run(repo, ["guidelines", "lint"], model("{}"));
    expect(lint.code).toBe(0);
  });

  it("errors on a missing pack", async () => {
    const repo = makeRepo();
    let stderr = "";
    const code = await runCli(["init", "--starter", "does/not/exist"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: model("{}"),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });
});
