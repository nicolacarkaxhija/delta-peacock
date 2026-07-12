import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

/** A repo whose feature branch introduces a console.log the guideline forbids. */
function makeScenario(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  commitAll(repo, "add guidelines");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
  commitAll(repo, "add logging");
  return repo;
}

function scriptedModel(text: string): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text, usage: { inputTokens: 100, outputTokens: 25 } });
      },
    },
  };
}

const CITED = JSON.stringify({
  findings: [
    {
      guidelineId: "no-console",
      file: "src/app.js",
      line: 2,
      title: "Console call added",
      body: "Replace the console.log with the logger.",
    },
  ],
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function review(
  repo: string,
  port: ModelPort | undefined,
  ...args: string[]
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["review", ...args], {
    cwd: repo,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    ...(port ? { modelPort: port } : {}),
  });
  return { code, stdout, stderr };
}

describe("review end to end (local mode)", () => {
  it("reviews a violating branch: cited finding, inherited severity, report artifact", async () => {
    const repo = makeScenario();
    const { port, requests } = scriptedModel(CITED);
    const { code, stdout } = await review(repo, port, "--report", "review.json");

    expect(code).toBe(0); // advisory by default
    expect(stdout).toContain("MAJOR");
    expect(stdout).toContain("src/app.js:2");
    expect(stdout).toContain("[no-console]");
    expect(stdout).toContain("gate: advisory");

    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(report.version).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      guidelineId: "no-console",
      severity: "MAJOR",
      file: "src/app.js",
    });
    expect(report.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(report.usage).toEqual({ inputTokens: 100, outputTokens: 25 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toContain("no-console");
    expect(requests[0]?.user).toContain("console.log(name)");
  });

  it("honors explicit --target and --guidelines-dir flags", async () => {
    const repo = makeScenario();
    const { code, stdout } = await review(
      repo,
      scriptedModel(CITED).port,
      "--target",
      "main",
      "--guidelines-dir",
      "guidelines",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("[no-console]");
  });

  it("fails the gate at exit 2 when a finding meets the threshold", async () => {
    const repo = makeScenario();
    const { code, stdout } = await review(repo, scriptedModel(CITED).port, "--fail-on", "MAJOR");
    expect(code).toBe(2);
    expect(stdout).toContain("FAILED");
  });

  it("passes the gate when findings sit below the threshold", async () => {
    const repo = makeScenario();
    const { code, stdout } = await review(repo, scriptedModel(CITED).port, "--fail-on", "CRITICAL");
    expect(code).toBe(0);
    expect(stdout).toContain("passed");
  });

  it("drops uncited findings and says so", async () => {
    const repo = makeScenario();
    const invented = JSON.stringify({
      findings: [{ guidelineId: "invented", file: "src/app.js", line: 2, title: "x", body: "y" }],
    });
    const { code, stdout } = await review(repo, scriptedModel(invented).port, "--report", "r.json");
    expect(code).toBe(0);
    expect(stdout).toContain("1 uncited finding(s) dropped");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.droppedUncitedFindings).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it("maps a malformed model response to the tool-error exit code", async () => {
    const repo = makeScenario();
    const { code, stderr } = await review(repo, scriptedModel("I refuse to answer in JSON.").port);
    expect(code).toBe(1);
    expect(stderr).toContain("JSON");
  });

  it("writes a report without usage when the model measured none", async () => {
    const repo = makeScenario();
    const silent: ModelPort = {
      complete: () => Promise.resolve({ text: CITED }),
    };
    const { code } = await review(repo, silent, "--report", "nousage.json");
    expect(code).toBe(0);
    const report = JSON.parse(
      readFileSync(path.join(repo, "nousage.json"), "utf8"),
    ) as ReviewReport;
    expect("usage" in report).toBe(false);
  });

  it("passes a ToolError from the model through unchanged", async () => {
    const repo = makeScenario();
    const { ToolError } = await import("../src/errors.js");
    const failing: ModelPort = {
      complete: () => Promise.reject(new ToolError("quota exhausted")),
    };
    const { code, stderr } = await review(repo, failing);
    expect(code).toBe(1);
    expect(stderr).toContain("quota exhausted");
    expect(stderr).not.toContain("model call failed");
  });

  it("maps a crashing model call to the tool-error exit code", async () => {
    const repo = makeScenario();
    const crashing: ModelPort = {
      complete: () => Promise.reject(new Error("socket hang up")),
    };
    const { code, stderr } = await review(repo, crashing);
    expect(code).toBe(1);
    expect(stderr).toContain("model call failed");
  });

  it("treats a missing guidelines directory as a tool error", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "changed\n");
    commitAll(repo, "change");
    const { code, stderr } = await review(repo, undefined);
    expect(code).toBe(1);
    expect(stderr).toContain("guidelines directory not found");
  });

  it("exits clean with a notice when the directory holds no usable guidelines", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/broken.md", "# not a guideline\n");
    commitAll(repo, "broken guideline");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "changed\n");
    commitAll(repo, "change");
    const { code, stdout, stderr } = await review(repo, undefined);
    expect(code).toBe(0);
    expect(stdout).toContain("no usable guidelines");
    expect(stderr).toContain("guideline skipped");
  });

  it("judges the branch by the target's rules even when the branch weakens them", async () => {
    const repo = makeScenario();
    // the feature branch tampers with the rule that judges it
    write(
      repo,
      "guidelines/no-console.md",
      "---\nid: no-console\nseverity: INFO\n---\n# No console statements\n\nweakened\n",
    );
    commitAll(repo, "weaken the rule");
    const { code, stdout } = await review(repo, scriptedModel(CITED).port, "--fail-on", "MAJOR");
    expect(code).toBe(2); // MAIN's MAJOR severity applies, not the branch's INFO
    expect(stdout).toContain("MAJOR");
  });

  it("honors --guidelines-ref source for the authoring loop", async () => {
    const repo = makeScenario();
    write(
      repo,
      "guidelines/no-console.md",
      "---\nid: no-console\nseverity: INFO\n---\n# No console statements\n\nsource version\n",
    );
    commitAll(repo, "adjust rule on branch");
    const { code, stdout } = await review(
      repo,
      scriptedModel(CITED).port,
      "--guidelines-ref",
      "source",
      "--fail-on",
      "MAJOR",
    );
    expect(code).toBe(0); // the working-tree INFO severity applies
    expect(stdout).toContain("INFO");
  });

  it("filters out guidelines that do not apply to the changed files", async () => {
    const repo = makeScenario();
    write(
      repo,
      "guidelines/python-only.md",
      "---\nid: python-only\nseverity: MAJOR\nlanguages: [python]\n---\npython rule\n",
    );
    git(repo, "checkout", "-q", "main");
    write(
      repo,
      "guidelines/python-only.md",
      "---\nid: python-only\nseverity: MAJOR\nlanguages: [python]\n---\npython rule\n",
    );
    commitAll(repo, "python rule on main");
    git(repo, "checkout", "-q", "feature");
    const { port, requests } = scriptedModel(CITED);
    const { code, stderr } = await review(repo, port);
    expect(code).toBe(0);
    expect(stderr).toContain("1 guideline(s) do not apply");
    expect(requests[0]?.system).not.toContain("python-only");
  });

  it("redacts a planted secret before it can reach the model", async () => {
    const repo = makeScenario();
    write(
      repo,
      "src/app.js",
      'const key = "AKIAIOSFODNN7EXAMPLE";\nconst mail = "someone@example.com";\n',
    );
    commitAll(repo, "leak a credential");
    const { port, requests } = scriptedModel(CITED);
    const { code, stderr } = await review(repo, port, "--report", "red.json");
    expect(code).toBe(0);
    expect(requests[0]?.user).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(requests[0]?.user).not.toContain("someone@example.com");
    expect(requests[0]?.user).toContain("[redacted:aws-access-key]");
    expect(stderr).toContain("redacted before the model call");
    const report = JSON.parse(readFileSync(path.join(repo, "red.json"), "utf8")) as ReviewReport;
    expect(report.redactions["aws-access-key"]).toBe(1);
    expect(report.redactions["email"]).toBe(1);
  });

  it("aborts as a tool error when a configured redaction pattern is broken", async () => {
    const repo = makeScenario();
    write(
      repo,
      "delta-peacock.config.yaml",
      'redaction:\n  patterns:\n    - name: broken\n      pattern: "(["\n',
    );
    const { port, requests } = scriptedModel(CITED);
    const { code, stderr } = await review(repo, port);
    expect(code).toBe(1);
    expect(stderr).toContain("broken");
    expect(requests).toHaveLength(0); // nothing reached the model
  });

  it("exits clean when no guideline applies to the change at all", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/python-only.md",
      "---\nid: python-only\nseverity: MAJOR\nlanguages: [python]\n---\npython rule\n",
    );
    commitAll(repo, "python rule");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "changed js\n");
    commitAll(repo, "js change");
    const { code, stdout } = await review(repo, undefined);
    expect(code).toBe(0);
    expect(stdout).toContain("no guidelines apply");
  });

  it("runs guidelines lint through the cli with an explicit dir", async () => {
    const repo = makeRepo();
    write(repo, "rules/a.md", "---\nid: a\nseverity: MAJOR\n---\nbody\n");
    let stdout = "";
    const code = await runCli(["guidelines", "lint", "--guidelines-dir", "rules"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("1 usable");
  });

  it("maps a failing guidelines lint to exit 1 through the cli", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/bad.md", "---\nseverity: MAJOR\n---\nbody\n");
    let stderr = "";
    const code = await runCli(["guidelines", "lint"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('"id"');
  });

  it("skips cleanly when the diff exceeds the size ceiling", async () => {
    const repo = makeScenario();
    const { code, stdout } = await review(repo, undefined, "--max-diff-bytes", "10");
    expect(code).toBe(0);
    expect(stdout).toContain("review skipped");
  });

  it("excluded paths never reach the model", async () => {
    const repo = makeScenario();
    const { port, requests } = scriptedModel(JSON.stringify({ findings: [] }));
    const { code } = await review(repo, port, "--exclude", "src/**");
    expect(code).toBe(0);
    expect(requests).toHaveLength(0); // the whole diff was excluded, no call made
  });

  it("exits clean with a notice when the branch changes nothing", async () => {
    const repo = makeScenario();
    git(repo, "checkout", "-q", "-b", "quiet", "main");
    const { code, stdout } = await review(repo, undefined);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to review");
  });

  it("requires a model id before it will call anything", async () => {
    const repo = makeScenario();
    const { code, stderr } = await review(repo, undefined);
    expect(code).toBe(1);
    expect(stderr).toContain("model.id");
  });

  it("requires the provider credential from the environment", async () => {
    const repo = makeScenario();
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_MODEL_ID: "claude-test" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects an unsupported provider with a clear message", async () => {
    const repo = makeScenario();
    let stderr = "";
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_MODEL_ID: "some-model", DELTA_PEACOCK_MODEL_PROVIDER: "bedrock" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("bedrock");
  });
});
