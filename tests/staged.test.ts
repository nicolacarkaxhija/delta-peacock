import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

const FINDING = JSON.stringify({
  findings: [
    { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Console", body: "b" },
  ],
});

function capture(text = FINDING): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text });
      },
    },
  };
}

/** A repo where one edit is staged and another is deliberately left unstaged. */
function stagedRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  write(repo, "src/app.js", "function greet(name) {\n  console.log('staged edit');\n}\n");
  git(repo, "add", "src/app.js");
  write(
    repo,
    "src/app.js",
    "function greet(name) {\n  console.log('staged edit');\n}\nunstagedTail();\n",
  );
  return repo;
}

async function runStaged(
  cwd: string,
  port: ModelPort,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["review", "--staged", ...args], {
    cwd,
    env,
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

describe("review --staged", () => {
  it("reviews only the index; unstaged edits never reach the prompt", async () => {
    const repo = stagedRepo();
    const { requests, port } = capture();
    const { code, stdout } = await runStaged(repo, port, ["--fail-on", "MAJOR"]);
    expect(code).toBe(2);
    expect(stdout).toContain("[no-console]");
    const sent = requests[0]?.user ?? "";
    expect(sent).toContain("staged edit");
    expect(sent).not.toContain("unstagedTail");
  });

  it("loads guidelines from the working tree, even uncommitted ones", async () => {
    const repo = makeRepo();
    write(repo, "src/app.js", "console.log('x');\n");
    git(repo, "add", "src/app.js");
    write(repo, "guidelines/no-console.md", GUIDELINE); // never committed, never staged
    const { requests, port } = capture();
    const { code } = await runStaged(repo, port);
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("no-console");
  });

  it("says so when nothing is staged", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { requests, port } = capture();
    const { code, stdout } = await runStaged(repo, port);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to review");
    expect(requests).toHaveLength(0);
  });

  it("rejects the incremental anchor and any configured SCM", async () => {
    const repo = stagedRepo();
    const anchored = await runStaged(repo, capture().port, [
      "--last-reviewed-commit",
      "0123456789abcdef",
    ]);
    expect(anchored.code).toBe(1);
    expect(anchored.stderr).toContain("cannot combine");

    const withScm = await runStaged(repo, capture().port, [], {
      DELTA_PEACOCK_SCM_PROVIDER: "github",
      DELTA_PEACOCK_SCM_REPOSITORY: "acme/widgets",
      DELTA_PEACOCK_SCM_PULL_REQUEST: "7",
    });
    expect(withScm.code).toBe(1);
    expect(withScm.stderr).toContain("needs no SCM");
  });

  it("honors the byte ceiling and path filters", async () => {
    const repo = stagedRepo();
    write(repo, "src/other.js", "otherStaged();\n");
    git(repo, "add", "src/other.js");
    const { requests, port } = capture();
    const filtered = await runStaged(repo, port, ["--exclude", "src/other.js"]);
    expect(filtered.code).toBe(0);
    expect(requests[0]?.user).not.toContain("otherStaged");

    const tiny = await runStaged(stagedRepo(), capture().port, ["--max-diff-bytes", "10"]);
    expect(tiny.code).toBe(0);
    expect(tiny.stdout).toContain("review skipped");
  });
});
