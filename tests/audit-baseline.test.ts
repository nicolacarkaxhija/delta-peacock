import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { batchFiles, fileAsDiff } from "../src/review/tree-scan.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

/** Flags every file the request's diff mentions, one finding at line 1. */
function perFilePort(): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const files = [...request.user.matchAll(/\+\+\+ b\/(.+)/g)].map((match) => match[1]);
        return Promise.resolve({
          text: JSON.stringify({
            findings: files.map((file) => ({
              guidelineId: "no-console",
              file,
              line: 1,
              title: `Console in ${String(file)}`,
              body: "b",
            })),
          }),
        });
      },
    },
  };
}

function auditRepo(): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  write(repo, "src/a.js", "console.log('a');\n");
  write(repo, "src/b.js", "console.log('b');\n");
  write(repo, "src/c.js", "console.log('c');\n");
  commitAll(repo, "base");
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

describe("audit", () => {
  it("reviews the whole tree in batches, dedups, gates and writes artifacts", async () => {
    const repo = auditRepo();
    const { requests, port } = perFilePort();
    const { code, stderr } = await run(
      repo,
      ["audit", "--fail-on", "MAJOR", "--report", "audit.json"],
      port,
    );
    expect(code).toBe(2);
    expect(stderr).toContain("batch(es)");
    expect(requests.length).toBeGreaterThan(0);
    const report = JSON.parse(readFileSync(path.join(repo, "audit.json"), "utf8")) as ReviewReport;
    // three seeded files plus the fixture repo's src/app.js
    expect(report.findings).toHaveLength(4);
    expect(report.findings[0]?.lineText).toBe("console.log('a');");
    expect(report.gate.failed).toBe(true);
  });

  it("splits into several batches under a tight byte ceiling", async () => {
    const repo = auditRepo();
    const { requests, port } = perFilePort();
    const { code, stderr } = await run(repo, ["audit", "--fail-on", "none"], port);
    expect(code).toBe(0);
    expect(requests).toHaveLength(1); // generous default ceiling: one batch
    expect(stderr).toContain("1 batch(es)");

    const tight = auditRepo();
    const second = perFilePort();
    let stderr2 = "";
    const code2 = await runCli(["audit"], {
      cwd: tight,
      env: { DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "150" },
      out: () => undefined,
      err: (text) => {
        stderr2 += text;
      },
      modelPort: second.port,
    });
    expect(code2).toBe(0); // advisory
    expect(second.requests.length).toBeGreaterThan(1);
    expect(stderr2).toContain(`${String(second.requests.length)} batch(es)`);
  });

  it("adopts a legacy codebase: write the baseline, then audits pass", async () => {
    const repo = auditRepo();
    const first = await run(
      repo,
      ["audit", "--fail-on", "MAJOR", "--write-baseline"],
      perFilePort().port,
    );
    expect(first.code).toBe(0); // everything accepted
    expect(first.stdout).toContain("baseline written: 4");
    expect(existsSync(path.join(repo, "delta-peacock.baseline.json"))).toBe(true);

    const second = await run(repo, ["audit", "--fail-on", "MAJOR"], perFilePort().port);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("4 baselined finding(s)");
  });

  it("skips an oversized file with a notice", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    write(repo, "src/huge.js", `console.log('${"x".repeat(500)}');\n`);
    write(repo, "src/small.js", "console.log('s');\n");
    commitAll(repo, "base");
    const { port } = perFilePort();
    let stderr = "";
    const code = await runCli(["audit"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "300" },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(stderr).toContain("src/huge.js alone exceeds");
  });

  it("needs guidelines and says when nothing matches their scope", async () => {
    const empty = makeRepo();
    const bare = await run(empty, ["audit"], perFilePort().port);
    expect(bare.code).toBe(1);

    const scoped = makeRepo();
    write(
      scoped,
      "guidelines/python-only.md",
      "---\nid: python-only\nseverity: MAJOR\nlanguages: [python]\n---\n# Py\n\nRule.\n",
    );
    write(scoped, "src/app.js", "js();\n");
    commitAll(scoped, "base");
    const out = await run(scoped, ["audit"], perFilePort().port);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("nothing to audit");
  });

  it("is blocked by the cost guard across all batches at once", async () => {
    const repo = auditRepo();
    const { requests, port } = perFilePort();
    let stdout = "";
    const code = await runCli(["audit"], {
      cwd: repo,
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
});

describe("baseline in the review pipeline", () => {
  const TWO = JSON.stringify({
    findings: [
      { guidelineId: "no-console", file: "src/app.js", line: 1, title: "One", body: "b" },
      { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Two", body: "b" },
    ],
  });
  const THREE = JSON.stringify({
    findings: [
      { guidelineId: "no-console", file: "src/app.js", line: 1, title: "One", body: "b" },
      { guidelineId: "no-console", file: "src/app.js", line: 2, title: "Two", body: "b" },
      { guidelineId: "no-console", file: "src/app.js", line: 3, title: "Three", body: "b" },
    ],
  });

  function reviewRepo(): string {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "console.log(1);\nconsole.log(2);\nconsole.log(3);\n");
    commitAll(repo, "change");
    return repo;
  }

  const model = (text: string): ModelPort => ({ complete: () => Promise.resolve({ text }) });

  it("write-baseline accepts today's findings; only new ones gate later", async () => {
    const repo = reviewRepo();
    const first = await run(repo, ["review", "--fail-on", "MAJOR", "--write-baseline"], model(TWO));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("baseline written: 2");

    const unchanged = await run(repo, ["review", "--fail-on", "MAJOR"], model(TWO));
    expect(unchanged.code).toBe(0);
    expect(unchanged.stderr).toContain("2 baselined finding(s)");

    const withNew = await run(
      repo,
      ["review", "--fail-on", "MAJOR", "--report", "r.json"],
      model(THREE),
    );
    expect(withNew.code).toBe(2); // the third finding is fresh and gates
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings.filter((finding) => finding.baselined === true)).toHaveLength(2);
    expect(report.gate.failing).toBe(1);
  });

  it("a corrupt baseline fails loudly", async () => {
    const repo = reviewRepo();
    write(repo, "delta-peacock.baseline.json", "{broken");
    const { code, stderr } = await run(repo, ["review"], model(TWO));
    expect(code).toBe(1);
    expect(stderr).toContain("not valid JSON");
  });
});

describe("audit edge paths", () => {
  it("passes tool errors through and wraps transport failures", async () => {
    const { ToolError } = await import("../src/errors.js");
    const tool = await run(auditRepo(), ["audit"], {
      complete: () => Promise.reject(new ToolError("credentials missing")),
    });
    expect(tool.code).toBe(1);
    expect(tool.stderr).toContain("credentials missing");
    const transport = await run(auditRepo(), ["audit"], {
      complete: () => Promise.reject(new Error("socket hangup")),
    });
    expect(transport.code).toBe(1);
    expect(transport.stderr).toContain("model call failed");
  });

  it("prices usage, writes all artifacts and counts redactions", async () => {
    const repo = auditRepo();
    // a runtime-built secret shape so redaction has something to count
    write(repo, "src/leak.js", `const token = "ghp_${"a1B2".repeat(9)}";\n`);
    commitAll(repo, "leak");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-audit-")), "spend.json");
    const priced: ModelPort = {
      complete: (request) =>
        Promise.resolve({
          text: JSON.stringify({
            findings: [
              {
                guidelineId: "no-console",
                file: [...request.user.matchAll(/\+\+\+ b\/(.+)/g)][0]?.[1] ?? "src/a.js",
                line: 1,
                title: "T",
                body: "b",
              },
            ],
          }),
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
    };
    let stderr = "";
    const code = await runCli(["audit", "--report", "audit.json"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "260",
        DELTA_PEACOCK_OUTPUT_SARIF_PATH: "audit.sarif",
        DELTA_PEACOCK_OUTPUT_CODE_QUALITY_PATH: "audit-quality.json",
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
        DELTA_PEACOCK_COST_COUNTER_PATH: counter,
        DELTA_PEACOCK_COST_MAX_PER_REVIEW: "1000",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: priced,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(repo, "audit.sarif"))).toBe(true);
    expect(existsSync(path.join(repo, "audit-quality.json"))).toBe(true);
    expect(existsSync(counter)).toBe(true);
    const report = JSON.parse(readFileSync(path.join(repo, "audit.json"), "utf8")) as ReviewReport;
    expect(report.cost?.total).toBeGreaterThan(0);
    expect(Object.values(report.redactions).some((count) => count > 0)).toBe(true);
    expect(stderr).toContain("batch(es)");
  });
});

describe("audit file selection", () => {
  it("honors include and exclude globs and skips binary and huge files", async () => {
    const repo = auditRepo();
    write(repo, "src/binary.js", "before after\n");
    write(repo, "src/fat.js", `// ${"y".repeat(300 * 1024)}\n`);
    write(repo, "docs/readme.md", "# hi\n");
    commitAll(repo, "extras");
    const { requests, port } = perFilePort();
    const { code } = await run(
      repo,
      ["audit", "--include", "src/**", "--exclude", "src/b.js"],
      port,
    );
    expect(code).toBe(0);
    const sent = requests.map((request) => request.user).join("\n");
    expect(sent).toContain("+++ b/src/a.js");
    expect(sent).not.toContain("+++ b/src/b.js"); // excluded
    expect(sent).not.toContain("docs/readme.md"); // not included
    expect(sent).not.toContain("binary.js"); // NUL byte means binary
    expect(sent).not.toContain("fat.js"); // over the per-file byte cap
  });

  it("reports nothing to audit when every file is oversized", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    write(repo, "src/only.js", `console.log('${"x".repeat(600)}');\n`);
    commitAll(repo, "base");
    let stdout = "";
    let stderr = "";
    const code = await runCli(["audit", "--include", "src/only.js"], {
      cwd: repo,
      env: { DELTA_PEACOCK_REVIEW_MAX_DIFF_BYTES: "300" },
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      modelPort: perFilePort().port,
    });
    expect(code).toBe(0);
    expect(stderr).toContain("alone exceeds");
    expect(stdout).toContain("nothing to audit");
  });

  it("writes sarif alone when no json report is configured", async () => {
    const repo = auditRepo();
    const code = await runCli(["audit"], {
      cwd: repo,
      env: { DELTA_PEACOCK_OUTPUT_SARIF_PATH: "only.sarif" },
      out: () => undefined,
      err: () => undefined,
      modelPort: perFilePort().port,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(repo, "only.sarif"))).toBe(true);
    expect(existsSync(path.join(repo, "audit.json"))).toBe(false);
  });

  it("skips malformed guidelines with a notice and audits with the rest", async () => {
    const repo = auditRepo();
    write(repo, "guidelines/broken.md", "---\nid: broken\n---\n# No severity\n\nBad.\n");
    commitAll(repo, "broken guideline");
    const { stderr, code } = await run(repo, ["audit"], perFilePort().port);
    expect(code).toBe(0);
    expect(stderr).toContain("guideline skipped");
  });

  it("builds the real model port only after the guard clears", async () => {
    let stdout = "";
    const code = await runCli(["audit"], {
      cwd: auditRepo(),
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
});

describe("baseline file shapes", () => {
  it("stamps the current fingerprint-scheme version on write", async () => {
    const { writeBaseline } = await import("../src/review/baseline.js");
    const repo = makeRepo();
    writeBaseline(repo, "delta-peacock.baseline.json", []);
    const raw = JSON.parse(
      readFileSync(path.join(repo, "delta-peacock.baseline.json"), "utf8"),
    ) as { version: number };
    // bumped alongside the observation fingerprint scheme change: a baseline
    // written under version 1 keys observations by title and will churn once
    expect(raw.version).toBe(2);
  });

  it("writes observations without a guideline id", async () => {
    const { writeBaseline, loadBaseline } = await import("../src/review/baseline.js");
    const repo = makeRepo();
    const count = writeBaseline(repo, "delta-peacock.baseline.json", [
      {
        kind: "observation",
        severity: "MINOR",
        file: "src/app.js",
        line: 4,
        title: "Thought",
        body: "b",
      },
    ]);
    expect(count).toBe(1);
    const entry = [...loadBaseline(repo, "delta-peacock.baseline.json").values()][0];
    expect(entry?.guidelineId).toBeUndefined();
    expect(entry?.title).toBe("Thought");
  });

  it("rejects a baseline without an entries array or fingerprints", async () => {
    const { loadBaseline } = await import("../src/review/baseline.js");
    const { ToolError } = await import("../src/errors.js");
    const repo = makeRepo();
    write(repo, "delta-peacock.baseline.json", JSON.stringify({ version: 1 }));
    expect(() => loadBaseline(repo, "delta-peacock.baseline.json")).toThrow(ToolError);
    write(
      repo,
      "delta-peacock.baseline.json",
      JSON.stringify({ version: 1, entries: [{ note: "no fingerprint" }] }),
    );
    expect(() => loadBaseline(repo, "delta-peacock.baseline.json")).toThrow(/fingerprint/);
  });

  it("tolerates a minimal entry that only carries a fingerprint", async () => {
    const { loadBaseline } = await import("../src/review/baseline.js");
    const repo = makeRepo();
    write(
      repo,
      "delta-peacock.baseline.json",
      JSON.stringify({ version: 1, entries: [{ fingerprint: "abc123def456" }] }),
    );
    const map = loadBaseline(repo, "delta-peacock.baseline.json");
    expect(map.get("abc123def456")).toMatchObject({ file: "", line: 0, title: "", note: "" });
  });

  it("an absent baseline file is simply empty", async () => {
    const { loadBaseline } = await import("../src/review/baseline.js");
    expect(loadBaseline(makeRepo(), "delta-peacock.baseline.json").size).toBe(0);
  });
});

describe("audit building blocks", () => {
  it("renders a file as an applyable new-file diff with correct numbering", () => {
    const diff = fileAsDiff("src/x.js", "one();\ntwo();\n");
    expect(diff).toContain("+++ b/src/x.js");
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff).toContain("+one();");
    expect(fileAsDiff("empty.js", "")).toContain("@@ -0,0 +1,0 @@");
  });

  it("packs files up to the ceiling and never splits one file", () => {
    const repo = makeRepo();
    write(repo, "a.js", "a();\n");
    write(repo, "b.js", "b();\n");
    write(repo, "c.js", "c();\n");
    const notices: string[] = [];
    const batches = batchFiles(repo, ["a.js", "b.js", "c.js"], 220, notices);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.files)).toEqual(["a.js", "b.js", "c.js"]);
    expect(notices).toEqual([]);
  });
});
