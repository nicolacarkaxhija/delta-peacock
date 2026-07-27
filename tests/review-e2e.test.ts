import { existsSync, readFileSync } from "node:fs";
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

  it("logs the payload of each rejected candidate under --explain-drops", async () => {
    const repo = makeScenario();
    const uncited = JSON.stringify({
      findings: [{ guidelineId: "invented", file: "src/app.js", line: 2, title: "x", body: "y" }],
    });
    const { code, stderr } = await review(repo, scriptedModel(uncited).port, "--explain-drops");
    expect(code).toBe(0);
    expect(stderr).toContain("invented");
  });

  it("harvests recurring uncited findings into drafts when review.harvestUncited is on", async () => {
    const repo = makeScenario();
    const twoUncited = JSON.stringify({
      findings: [
        { file: "src/app.js", line: 2, title: "Magic number", body: "b", severity: "MINOR" },
        { file: "src/app.js", line: 3, title: "Magic number", body: "b", severity: "MINOR" },
      ],
    });
    const code = await runCli(["review"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_HARVEST_UNCITED: "true" },
      out: () => undefined,
      err: () => undefined,
      modelPort: scriptedModel(twoUncited).port,
    });
    expect(code).toBe(0);
    const draft = path.join(repo, "guidelines-drafts", "magic-number.md");
    expect(existsSync(draft)).toBe(true);
    expect(readFileSync(draft, "utf8")).toContain("Magic number");
  });

  it("records rejected candidates in the JSON report", async () => {
    const repo = makeScenario();
    const uncited = JSON.stringify({
      findings: [{ guidelineId: "invented", file: "src/app.js", line: 2, title: "x", body: "y" }],
    });
    await review(repo, scriptedModel(uncited).port, "--report", "review.json");
    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(report.rejectedCandidates?.[0]).toMatchObject({ reason: "uncited" });
    expect(report.rejectedCandidates?.[0]?.raw).toContain("invented");
  });

  it("fails the gate at exit 2 when a finding meets the threshold", async () => {
    const repo = makeScenario();
    const { code, stdout } = await review(repo, scriptedModel(CITED).port, "--fail-on", "MAJOR");
    expect(code).toBe(2);
    expect(stdout).toContain("FAILED");
  });

  it("waives a violation carrying a matching in-code waiver: reported, not gating", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "add guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(
      repo,
      "src/app.js",
      "function greet(name) {\n  console.log(name); // delta-peacock:allow no-console — legacy shim\n  return name;\n}\n",
    );
    commitAll(repo, "add logging with a waiver");
    const { code, stdout } = await review(
      repo,
      scriptedModel(CITED).port,
      "--fail-on",
      "MAJOR",
      "--report",
      "review.json",
    );
    expect(code).toBe(0); // waived: the gate passes despite --fail-on MAJOR
    expect(stdout).toContain("waived");
    expect(stdout).toContain("legacy shim");

    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    expect(report.findings).toHaveLength(0); // the sole finding was waived
    expect(report.waived).toHaveLength(1);
    expect(report.waived?.[0]).toMatchObject({ guidelineId: "no-console", reason: "legacy shim" });
  });

  it("keeps the gate suppressed for an expired waiver but flags it stale", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "add guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(
      repo,
      "src/app.js",
      "function greet(name) {\n  console.log(name); // delta-peacock:allow no-console — shim until=2020-01-01\n  return name;\n}\n",
    );
    commitAll(repo, "add logging with an expired waiver");
    const { code, stdout } = await review(repo, scriptedModel(CITED).port, "--fail-on", "MAJOR");
    expect(code).toBe(0); // an expired waiver still suppresses the gate (ADR 0008)
    expect(stdout).toContain("expired");
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

  it("honors an incremental anchor passed through the cli", async () => {
    const repo = makeScenario();
    const { headSha } = await import("./helpers/git.js");
    const anchor = headSha(repo);
    write(repo, "src/later.js", "const later = true;\n");
    commitAll(repo, "later work");
    const { port, requests } = scriptedModel(JSON.stringify({ findings: [] }));
    const { code, stderr } = await review(repo, port, "--last-reviewed-commit", anchor);
    expect(code).toBe(0);
    expect(stderr).toContain("incremental review");
    expect(requests[0]?.user).toContain("later.js");
    expect(requests[0]?.user).not.toContain("console.log(name)");
  });

  it("prices the review in the report when rates are configured", async () => {
    const repo = makeScenario();
    const code = await runCli(["review", "--report", "priced.json"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: scriptedModel(CITED).port,
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "priced.json"), "utf8")) as {
      cost?: { total: number };
      usage?: { inputTokens: number };
    };
    expect(report.usage?.inputTokens).toBe(100);
    expect(report.cost?.total).toBeCloseTo((100 / 1e6) * 3 + (25 / 1e6) * 15);
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

  it("keeps low-confidence findings out of the output but inside the report", async () => {
    const repo = makeScenario();
    const cited = JSON.parse(CITED) as { findings: Record<string, unknown>[] };
    const shaky = JSON.stringify({
      findings: [
        { ...cited.findings[0], confidence: 0.9 },
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 3,
          title: "Maybe also here",
          body: "unsure",
          confidence: 0.2,
        },
      ],
    });
    const { code, stdout } = await review(
      repo,
      scriptedModel(shaky).port,
      "--report",
      "conf.json",
      "--fail-on",
      "MAJOR",
    );
    expect(code).toBe(2);
    expect(stdout).toContain("1 finding(s)");
    expect(stdout).toContain("under the confidence floor");
    expect(stdout).not.toContain("Maybe also here");
    const report = JSON.parse(readFileSync(path.join(repo, "conf.json"), "utf8")) as ReviewReport;
    expect(report.findings).toHaveLength(1);
    expect(report.filtered).toHaveLength(1);
    expect(report.filtered[0]?.title).toBe("Maybe also here");
  });

  it("general pass observations render labeled, propose guidelines, and never gate", async () => {
    const repo = makeScenario();
    const withObservation = JSON.stringify({
      findings: [
        {
          file: "src/app.js",
          line: 2,
          title: "SQL injection risk",
          body: "String concatenation into a query.",
          severity: "BLOCKER",
          confidence: 0.95,
          proposedGuideline: {
            id: "no-sql-concat",
            severity: "CRITICAL",
            rationale: "recurring pattern worth codifying",
          },
        },
      ],
    });
    const { code, stdout } = await review(
      repo,
      scriptedModel(withObservation).port,
      "--fail-on",
      "INFO",
      "--report",
      "obs.json",
    );
    // enable the general pass via env in a second run to compare gating
    expect(code).toBe(0); // general pass OFF: uncited finding dropped, nothing gates
    expect(stdout).toContain("1 uncited finding(s) dropped");

    let stdout2 = "";
    const code2 = await runCli(["review", "--fail-on", "INFO", "--report", "obs.json"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_GENERAL_PASS: "true" },
      out: (text) => {
        stdout2 += text;
      },
      err: () => undefined,
      modelPort: scriptedModel(withObservation).port,
    });
    expect(code2).toBe(0); // observation present but observations never gate
    expect(stdout2).toContain("[observation] SQL injection risk");
    expect(stdout2).toContain("MINOR"); // BLOCKER claim capped to the default MINOR
    expect(stdout2).toContain("no-sql-concat (CRITICAL): recurring pattern worth codifying");
    const report = JSON.parse(readFileSync(path.join(repo, "obs.json"), "utf8")) as ReviewReport;
    expect(report.proposedGuidelines).toHaveLength(1);
    expect(report.findings[0]?.kind).toBe("observation");
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

  it("names the missing credential for a provider without one", async () => {
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
    expect(stderr).toContain("AWS_REGION");
  });
});

describe("line-anchor repair", () => {
  /** A brand-new file: every line is added, so newLineTexts covers all of it. */
  function makeLoopScenario(): string {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "add guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(
      repo,
      "src/orders/total.js",
      [
        "function total(lineItems) {",
        "  let sum = 0;",
        "  for (let i = 0; i < lineItems.length; i++) {",
        "    const lineItem = lineItems[i];",
        "    sum += lineItem.price;",
        "  }",
        "  return sum;",
        "}",
      ].join("\n") + "\n",
    );
    commitAll(repo, "add order total");
    return repo;
  }

  it("relocates a finding to the changed line containing its own cited snippet", async () => {
    const repo = makeLoopScenario();
    // the model names the for-loop's own line, but quotes code that actually
    // sits one line below it -- the drift the live tool showed across runs
    const misplaced = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/orders/total.js",
          line: 3,
          title: "Loop variable is unclear",
          body: "Rename it: `const lineItem = lineItems[i];` reads better as `const item = ...`.",
        },
      ],
    });
    const { code, stdout } = await review(
      repo,
      scriptedModel(misplaced).port,
      "--report",
      "r.json",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("src/orders/total.js:4");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings[0]?.line).toBe(4);
  });

  it("keeps the model's line when no changed line matches its cited snippet", async () => {
    const repo = makeScenario();
    const noMatch = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 2,
          title: "Console call added",
          body: "Replace `this.exact.text.appears.nowhere()` with the logger.",
        },
      ],
    });
    const { code } = await review(repo, scriptedModel(noMatch).port, "--report", "r.json");
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings[0]?.line).toBe(2);
  });

  it("leaves an already-correct line untouched", async () => {
    const repo = makeLoopScenario();
    const correct = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/orders/total.js",
          line: 4,
          title: "Loop variable is unclear",
          body: "Rename it: `const lineItem = lineItems[i];` reads better as `const item = ...`.",
        },
      ],
    });
    const { code } = await review(repo, scriptedModel(correct).port, "--report", "r.json");
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings[0]?.line).toBe(4);
  });
});

describe("duplicate finding collapse", () => {
  it("reports a finding once even when the model repeats it within a single reply", async () => {
    const repo = makeScenario();
    // the live tool saw a single (unbatched) reply cite the same guideline at the
    // same file and line twice, worded differently each time -- both survived
    // into the final report as if they were distinct findings
    const repeated = JSON.stringify({
      findings: [
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 2,
          title: "Console call added",
          body: "Replace the console.log with the logger.",
        },
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 2,
          title: "Console statement present",
          body: "This line calls console.log directly.",
        },
        {
          guidelineId: "no-console",
          file: "src/app.js",
          line: 3,
          title: "A genuinely distinct finding",
          body: "A different line; must not be merged away with the others.",
        },
      ],
    });
    const { code, stdout } = await review(repo, scriptedModel(repeated).port, "--report", "r.json");
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    // same file + line + guidelineId is the same finding: reported once, not twice
    expect(report.findings.filter((finding) => finding.line === 2)).toHaveLength(1);
    // a genuinely different line is a different finding and survives alongside it
    expect(report.findings).toHaveLength(2);
    expect(stdout).toContain("src/app.js:2");
    expect(stdout).toContain("src/app.js:3");
  });
});

describe("partial batch parse failures", () => {
  // a real 439-file PR hit this: 4 batches went out, one reply held no JSON
  // object, and the ToolError from parsing it aborted the whole review --
  // discarding the other three batches' findings and writing no report at all
  /** Two files, each padded past a tiny window so the diff splits one-file-per-batch. */
  function makeTwoBatchScenario(): string {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "add guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/a.js", `console.log('${"a".repeat(400)}');\n`);
    write(repo, "src/b.js", `console.log('${"b".repeat(400)}');\n`);
    commitAll(repo, "add logging");
    return repo;
  }

  /** The batch touching src/a.js answers with prose holding no JSON object; src/b.js's is clean. */
  function partlyUnparseablePort(): { port: ModelPort; requests: ModelRequest[] } {
    const requests: ModelRequest[] = [];
    return {
      requests,
      port: {
        complete(request) {
          requests.push(request);
          const files = [...request.user.matchAll(/\+\+\+ b\/(.+)/g)].map((m) => m[1]);
          if (files.includes("src/a.js")) {
            return Promise.resolve({ text: "Sorry, I cannot review this right now." });
          }
          return Promise.resolve({
            text: JSON.stringify({
              findings: files.map((file) => ({
                guidelineId: "no-console",
                file,
                line: 1,
                title: "Console call added",
                body: "Replace with the logger.",
              })),
            }),
          });
        },
      },
    };
  }

  it("keeps the other batches' findings and records the unparsed one instead of aborting the run", async () => {
    const repo = makeTwoBatchScenario();
    const { port, requests } = partlyUnparseablePort();
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_WINDOW_TOKENS: "150" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(requests.length).toBe(2); // sanity: the diff really did split into two batches
    expect(code).toBe(0); // one unparseable batch must not abort an otherwise-clean review
    expect(stderr).toMatch(/batch \d+\/2: .+; skipping this batch's findings/);

    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    // src/b.js's finding survived even though src/a.js's batch could not be parsed
    expect(report.findings.map((finding) => finding.file)).toEqual(["src/b.js"]);
    expect(report.unparsedBatches).toHaveLength(1);
    expect(report.unparsedBatches?.[0]?.of).toBe(2);
    expect(report.unparsedBatches?.[0]?.reason).toContain("JSON");
  });

  it("still fails the run when every batch's reply is unparseable", async () => {
    const repo = makeTwoBatchScenario();
    const allBroken: ModelPort = {
      complete: () => Promise.resolve({ text: "Nope, no findings here." }),
    };
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_WINDOW_TOKENS: "150" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: allBroken,
    });
    expect(code).toBe(1); // every batch failing to parse is a genuine failure, not a clean pass
    expect(stderr).toContain("every batch");
    expect(existsSync(path.join(repo, "r.json"))).toBe(false); // no partial report on total failure
  });
});
