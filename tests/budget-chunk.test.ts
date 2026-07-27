import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkSource } from "../src/context/chunk.js";
import { planBudget, splitDiffByFile } from "../src/review/budget.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

describe("boundary-aware chunking", () => {
  it("never splits a function whose body fits in one chunk", () => {
    const source = [
      "function alpha(x) {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b + x;",
      "}",
      "",
      "function beta(y) {",
      "  return y * 2;",
      "}",
    ].join("\n");
    const chunks = chunkSource("src/app.js", source);
    // each function lands whole in exactly one chunk
    const alphaChunk = chunks.find((chunk) => chunk.text.includes("function alpha"));
    expect(alphaChunk?.text).toContain("return a + b + x;");
    expect(alphaChunk?.text).not.toContain("function beta");
    const betaChunk = chunks.find((chunk) => chunk.text.includes("function beta"));
    expect(betaChunk?.text).toContain("return y * 2;");
  });

  it("keeps a nested helper with its parent, not as its own chunk", () => {
    const source = [
      "function outer() {",
      "  const inner = () => {",
      "    return 1;",
      "  };",
      "  return inner();",
      "}",
    ].join("\n");
    const chunks = chunkSource("src/app.js", source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("const inner");
  });

  it("splits an oversized declaration body at blank lines", () => {
    const body = Array.from({ length: 80 }, (_, i) =>
      i % 20 === 19 ? "" : `  step${String(i)}();`,
    );
    const source = ["function huge() {", ...body, "}"].join("\n");
    const chunks = chunkSource("src/app.js", source);
    expect(chunks.length).toBeGreaterThan(1);
    // no chunk ends mid-statement: each split happened on a blank line boundary
    for (const chunk of chunks.slice(0, -1)) {
      const last = chunk.text.split("\n").at(-1) ?? "";
      expect(last === "" || last.startsWith("  step")).toBe(true);
    }
  });

  it("returns nothing for empty or whitespace content", () => {
    expect(chunkSource("a.js", "")).toEqual([]);
    expect(chunkSource("a.js", "\n\n  \n")).toEqual([]);
  });

  it("treats a file that opens on a declaration and one without any as one chunk", () => {
    // first line is a boundary: no empty leading segment is emitted
    const leading = chunkSource("a.js", "function f() {\n  return 1;\n}\n");
    expect(leading).toHaveLength(1);
    // an unknown extension has no pattern, so the whole file is one chunk
    const noPattern = chunkSource("data.txt", "line one\nline two\nline three\n");
    expect(noPattern).toHaveLength(1);
    expect(noPattern[0]?.startLine).toBe(1);
  });

  it("flushes a trailing oversized segment that never hits a blank line", () => {
    const source = [
      "function huge() {",
      ...Array.from({ length: 90 }, (_, i) => `  s${String(i)}();`),
      "}",
    ].join("\n");
    const chunks = chunkSource("a.js", source);
    // the body has no blank lines, so it stays one oversized chunk, not lost
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("s89();");
  });
});

describe("the budget planner", () => {
  const prefix = "x".repeat(400); // ~100 tokens
  it("does not degrade when everything fits", () => {
    const plan = planBudget({ prefix, context: "ctx", diff: "diff", windowTokens: 1000 });
    expect(plan.dropContext).toBe(false);
    expect(plan.batchDiff).toBe(false);
    expect(plan.notices).toEqual([]);
  });

  it("drops context first when the prompt is over", () => {
    const plan = planBudget({
      prefix,
      context: "y".repeat(4000), // ~1000 tokens of context
      diff: "d".repeat(400),
      windowTokens: 200,
    });
    expect(plan.dropContext).toBe(true);
    expect(plan.batchDiff).toBe(false);
    expect(plan.notices[0]).toContain("dropping cross-file context");
  });

  it("batches the diff when even the diff alone is over", () => {
    const plan = planBudget({
      prefix,
      context: "",
      diff: "d".repeat(8000), // ~2000 tokens, over a 200-token window
      windowTokens: 200,
    });
    expect(plan.batchDiff).toBe(true);
    expect(plan.notices[0]).toContain("splitting the diff");
  });
});

describe("splitDiffByFile", () => {
  it("groups file chunks under the budget and never splits one file", () => {
    const diff = ["a", "b", "c"]
      .map((name) => `diff --git a/${name}.js b/${name}.js\n@@ -0,0 +1 @@\n+${name.repeat(200)}\n`)
      .join("");
    const batches = splitDiffByFile(diff, 60); // ~each file is ~50+ tokens
    expect(batches.length).toBeGreaterThan(1);
    // every original file chunk survives intact somewhere
    for (const name of ["a", "b", "c"]) {
      expect(batches.some((batch) => batch.includes(`b/${name}.js`))).toBe(true);
    }
  });

  it("returns the whole diff when it carries no file headers", () => {
    expect(splitDiffByFile("+just a loose line\n", 10)).toEqual(["+just a loose line\n"]);
    // an empty diff yields the single empty batch, never zero
    expect(splitDiffByFile("", 10)).toEqual([""]);
  });
});

describe("review degradation end to end", () => {
  const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

  /** Flags every file the request mentions, so batching can be observed. */
  function perFilePort(): { requests: ModelRequest[]; port: ModelPort } {
    const requests: ModelRequest[] = [];
    return {
      requests,
      port: {
        complete(request) {
          requests.push(request);
          const files = [...request.user.matchAll(/\+\+\+ b\/(.+)/g)].map((m) => m[1]);
          return Promise.resolve({
            text: JSON.stringify({
              findings: files.map((file) => ({
                guidelineId: "no-console",
                file,
                line: 1,
                title: "C",
                body: "b",
              })),
            }),
          });
        },
      },
    };
  }

  it("batches a diff that cannot fit the window and merges the findings", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/a.js", `console.log('${"a".repeat(400)}');\n`);
    write(repo, "src/b.js", `console.log('${"b".repeat(400)}');\n`);
    commitAll(repo, "change");
    const { requests, port } = perFilePort();
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
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(1); // the diff was split
    expect(stderr).toContain("file-boundary batches");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.budgetDegraded).toBe(true);
    // both files' findings survived the merge
    expect(report.findings.map((f) => f.file).sort()).toEqual(["src/a.js", "src/b.js"]);
  });

  it("still serves agentic tools to every batch when the diff must be split", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/a.js", `console.log('${"a".repeat(400)}');\n`);
    write(repo, "src/b.js", `console.log('${"b".repeat(400)}');\n`);
    commitAll(repo, "change");
    const { requests, port } = perFilePort();
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_REVIEW_WINDOW_TOKENS: "150",
        DELTA_PEACOCK_CONTEXT_PROVIDER: "agentic",
      },
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(stderr).toContain("file-boundary batches");
    expect(requests.length).toBeGreaterThan(1); // the diff was still split into batches
    // every batch keeps its agentic tools available, not just a single unsplit request
    for (const request of requests) {
      expect(request.tools).toBeDefined();
      expect(Object.keys(request.tools ?? {})).toContain("get_definition");
    }
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.budgetDegraded).toBe(true);
  });

  it("sums usage and tool calls across batches", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/a.js", `console.log('${"a".repeat(400)}');\n`);
    write(repo, "src/b.js", `console.log('${"b".repeat(400)}');\n`);
    commitAll(repo, "change");
    const priced: ModelPort = {
      complete: (request) => {
        const files = [...request.user.matchAll(/\+\+\+ b\/(.+)/g)].map((m) => m[1]);
        return Promise.resolve({
          text: JSON.stringify({
            findings: files.map((file) => ({
              guidelineId: "no-console",
              file,
              line: 1,
              title: "C",
              body: "b",
            })),
          }),
          usage: { inputTokens: 100, outputTokens: 10 },
          toolCalls: 1,
        });
      },
    };
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_REVIEW_WINDOW_TOKENS: "150",
        DELTA_PEACOCK_COST_RATE_INPUT_PER_1M: "3",
        DELTA_PEACOCK_COST_RATE_OUTPUT_PER_1M: "15",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: priced,
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport & {
      toolCalls?: number;
    };
    // two batches, each 100 in / 10 out and one tool call, summed
    expect(report.usage?.inputTokens).toBe(200);
    expect(report.toolCalls).toBe(2);
  });

  it("guidelines lint warns on an oversized guideline", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/huge.md",
      `---\nid: huge\nseverity: MAJOR\nlanguages: [javascript]\npaths: ["src/**"]\n---\n# Huge\n\n${"word ".repeat(2000)}\n`,
    );
    // fully scoped, unlike the shared GUIDELINE fixture, so it draws no
    // frontmatter-contract notice of its own: this test is only about the
    // oversized-guideline warning, not the unrelated fine.md
    write(
      repo,
      "guidelines/fine.md",
      '---\nid: no-console\nseverity: MAJOR\nlanguages: [javascript]\npaths: ["src/**"]\n---\n# No console\n\nUse the logger.\n',
    );
    commitAll(repo, "rules");
    let stderr = "";
    const code = await runCli(["guidelines", "lint"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.resolve({ text: "{}" }) },
    });
    expect(code).toBe(0); // a warning, not a failure
    expect(stderr).toContain("over the 1500-token budget");
    expect(stderr).toContain("huge.md");
    expect(stderr).not.toContain("fine.md");
  });
});
