import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function repoWithChange(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  commitAll(repo, "change");
  return repo;
}

function capture(): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: `answer ${String(requests.length)} [no-console]` });
      },
    },
  };
}

describe("ask one-shot", () => {
  it("grounds the question in the diff and the guidelines", async () => {
    const { requests, port } = capture();
    let stdout = "";
    const code = await runCli(["ask", "does this violate anything?"], {
      cwd: repoWithChange(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("answer 1 [no-console]");
    const request = requests[0];
    expect(request?.system).toContain("## Guidelines");
    expect(request?.system).toContain("no-console");
    expect(request?.user).toContain("console.log('x')");
    expect(request?.user).toContain("Question: does this violate anything?");
  });

  it("requires a question outside interactive mode", async () => {
    let stderr = "";
    const code = await runCli(["ask"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: capture().port,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("needs a question");
  });

  it("answers even when the branch has no changes", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    const { requests, port } = capture();
    const code = await runCli(["ask", "what do the guidelines forbid?"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    // with no diff to scope by, the whole corpus is available
    expect(requests[0]?.system).toContain("no-console");
  });

  it("dry run prepares everything but never calls the model", async () => {
    const { requests, port } = capture();
    let stdout = "";
    const code = await runCli(["ask", "anything?", "--dry-run"], {
      cwd: repoWithChange(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(stdout).toContain("no model was called");
  });

  it("is blocked by the cost guard", async () => {
    const { requests, port } = capture();
    let stdout = "";
    const code = await runCli(["ask", "anything?"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "1000000",
        DELTA_PEACOCK_COST_MAX_PER_REVIEW: "0.000001",
      },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(stdout).toContain("blocked by the cost guard");
  });

  it("warns when caps are set without rates and still answers", async () => {
    const { requests, port } = capture();
    let stderrText = "";
    const code = await runCli(["ask", "anything?"], {
      cwd: repoWithChange(),
      env: { DELTA_PEACOCK_COST_MAX_PER_REVIEW: "1" },
      out: () => undefined,
      err: (text) => {
        stderrText += text;
      },
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(stderrText).toContain("no rates are configured");
  });

  it("injects project context when the map finds related files", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    write(
      repo,
      "src/caller.js",
      "const { greet } = require('./app.js');\nmodule.exports = () => greet('x');\n",
    );
    commitAll(repo, "base with caller");
    git(repo, "checkout", "-q", "-b", "feature");
    write(
      repo,
      "src/app.js",
      "function greet(name, formal) {\n  return name;\n}\nmodule.exports = { greet };\n",
    );
    commitAll(repo, "change greet");
    const { requests, port } = capture();
    const code = await runCli(["ask", "who is affected?"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("## Project context");
    expect(requests[0]?.system).toContain("caller.js");
  });

  it("passes context tools through to the request", async () => {
    const { requests, port } = capture();
    const code = await runCli(["ask", "who calls greet?"], {
      cwd: repoWithChange(),
      env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "agentic" },
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(Object.keys(requests[0]?.tools ?? {})).toContain("find_references");
  });
});

describe("ask edge paths", () => {
  it("skips when the diff exceeds the size ceiling", async () => {
    let stdout = "";
    const code = await runCli(["ask", "anything?"], {
      cwd: repoWithChange(),
      env: { DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "10" },
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: capture().port,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ask skipped");
  });

  it("says so when the repository declares no guidelines", async () => {
    const repo = makeRepo();
    write(repo, "README.md", "hi\n");
    commitAll(repo, "base");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "x\n");
    commitAll(repo, "change");
    const { requests, port } = capture();
    const code = await runCli(["ask", "anything?"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("declares no guidelines");
  });

  it("passes a tool error through and wraps transport failures", async () => {
    const { ToolError } = await import("../src/errors.js");
    const run = (port: ModelPort) => {
      let stderr = "";
      return runCli(["ask", "anything?"], {
        cwd: repoWithChange(),
        env: {},
        out: () => undefined,
        err: (text) => {
          stderr += text;
        },
        modelPort: port,
      }).then((code) => ({ code, stderr }));
    };
    const toolFailure = await run({
      complete: () => Promise.reject(new ToolError("credentials missing")),
    });
    expect(toolFailure.code).toBe(1);
    expect(toolFailure.stderr).toContain("credentials missing");
    const transport = await run({ complete: () => Promise.reject(new Error("socket hangup")) });
    expect(transport.code).toBe(1);
    expect(transport.stderr).toContain("model call failed");
  });

  it("falls back to working-tree guidelines with a notice when the target lacks them", async () => {
    const repo = makeRepo();
    write(repo, "README.md", "hi\n");
    commitAll(repo, "base without guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "console.log('x');\n");
    commitAll(repo, "change");
    write(repo, "guidelines/no-console.md", GUIDELINE); // uncommitted, working tree only
    const { requests, port } = capture();
    let stderr = "";
    const code = await runCli(["ask", "anything?"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(stderr.length).toBeGreaterThan(0); // the fallback said so
    expect(requests[0]?.system).toContain("no-console");
  });

  it("builds the real model port when none is injected, still behind the guard", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["ask", "anything?"], {
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
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1); // blocked before any network call
    expect(stdout + stderr).toContain("cost guard");
  });

  it("records priced usage per answered turn", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-ask-")), "spend.json");
    const code = await runCli(["ask", "anything?"], {
      cwd: repoWithChange(),
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        DELTA_PEACOCK_COST_COUNTER_PATH: counter,
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: {
        complete: () =>
          Promise.resolve({ text: "answer", usage: { inputTokens: 10, outputTokens: 5 } }),
      },
    });
    expect(code).toBe(0);
    expect(existsSync(counter)).toBe(true);
  });
});

describe("ask interactive session", () => {
  function scriptedLines(lines: (string | null)[]): () => Promise<string | null> {
    const queue = [...lines];
    return () => Promise.resolve(queue.shift() ?? null);
  }

  it("keeps earlier turns in the prompt and ends at end of input", async () => {
    const { requests, port } = capture();
    let stdout = "";
    const code = await runCli(["ask", "--interactive"], {
      cwd: repoWithChange(),
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
      readLine: scriptedLines(["first question", "second question", null]),
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("Earlier question: first question");
    expect(requests[1]?.user).toContain("answer 1 [no-console]");
    expect(stdout).toContain("answer 2");
  });

  it("a seeded question plus .exit asks exactly once", async () => {
    const { requests, port } = capture();
    const code = await runCli(["ask", "seed question", "--interactive"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
      readLine: scriptedLines([".exit"]),
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("an empty line ends the session quietly", async () => {
    const { requests, port } = capture();
    const code = await runCli(["ask", "--interactive"], {
      cwd: repoWithChange(),
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
      readLine: scriptedLines(["   ", "never reached"]),
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
