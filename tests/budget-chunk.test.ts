import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { approximateTokens } from "../src/context/port.js";
import { chunkSource } from "../src/context/chunk.js";
import { changedFilesFromDiff } from "../src/git/diff.js";
import { planBatches, planBudget, splitDiffByFile } from "../src/review/budget.js";
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

describe("planBatches", () => {
  const prefix = "p".repeat(40); // 10 tokens
  const context = "c".repeat(200); // 50 tokens
  const windowTokens = 100;
  // generous enough that it never binds: these cases are about window-driven
  // packing, not the attention budget, which gets its own describe block below
  const slackAttentionBudget = { maxFiles: 1000, maxTokens: 1_000_000 };

  function fileDiff(name: string, contentLen: number): string {
    return `diff --git a/${name}.js b/${name}.js\n@@ -0,0 +1 @@\n+${"a".repeat(contentLen)}\n`;
  }

  it("packs many small files to fit the window with context reserved, isolating only the oversized file", () => {
    const normalFiles = Array.from({ length: 10 }, (_, i) => fileDiff(`f${String(i)}`, 16)).join(
      "",
    );
    const diff = normalFiles + fileDiff("huge", 400);
    const whole = planBudget({ prefix, context, diff, windowTokens });
    expect(whole.batchDiff).toBe(true); // sanity: this fixture does need batching

    const plan = planBatches(whole, diff, context, prefix, windowTokens, slackAttentionBudget);

    // budget-driven, not a fixed/small count: 10 small files pack two-per-batch
    // plus the oversized file riding alone
    expect(plan.diffBatches.length).toBe(6);
    expect(plan.diffBatches.length).toBeGreaterThan(2);

    // every batch except the oversized file keeps its full context
    for (const batchContext of plan.batchContexts.slice(0, 5)) {
      expect(batchContext).toBe(context);
    }
    // and each of those batches, reassembled with prefix + context, provably
    // fits the window -- not just asserted by field name
    for (const batchDiff of plan.diffBatches.slice(0, 5)) {
      const reassembled = planBudget({ prefix, context, diff: batchDiff, windowTokens });
      expect(reassembled.batchDiff).toBe(false);
      expect(reassembled.dropContext).toBe(false);
    }

    // the one file too big for the window even alone rides without context
    expect(plan.batchContexts[5]).toBe("");
    expect(plan.diffBatches[5]).toContain("huge.js");

    // named just that one file, never a roll call of every batched path
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain("huge.js");
    expect(plan.notices[0]).not.toContain("f0.js");
    expect(plan.notices[0]).not.toContain("f9.js");

    expect(plan.degraded).toBe(true);
  });

  it("does not degrade when every packed batch affords its context", () => {
    // ten small files force batching under this tiny window, but none is too
    // big to share a batch with its neighbors once packing reserves room for
    // prefix + context -- batching by itself is not degradation
    const diff = Array.from({ length: 10 }, (_, i) => fileDiff(`f${String(i)}`, 16)).join("");
    const whole = planBudget({ prefix, context, diff, windowTokens });
    expect(whole.batchDiff).toBe(true);

    const plan = planBatches(whole, diff, context, prefix, windowTokens, slackAttentionBudget);
    expect(plan.diffBatches.length).toBeGreaterThan(1);
    expect(plan.notices).toEqual([]);
    expect(plan.degraded).toBe(false);
    for (const batchContext of plan.batchContexts) expect(batchContext).toBe(context);
  });

  it("does not batch at all when the whole diff already fits", () => {
    const plan = planBatches(
      { dropContext: false, batchDiff: false, notices: [], estimatedTokens: 10 },
      "diff",
      context,
      prefix,
      windowTokens,
      slackAttentionBudget,
    );
    expect(plan.diffBatches).toEqual(["diff"]);
    expect(plan.batchContexts).toEqual([context]);
    expect(plan.degraded).toBe(false);
    expect(plan.notices).toEqual([]);
  });
});

describe("planBatches — attention budget", () => {
  // a window this large would never force batching on its own; fitting the
  // window is necessary but not sufficient -- attention degrades with file
  // count long before the token limit binds, so the batch itself needs a cap
  const prefix = "p".repeat(40); // 10 tokens
  const context = "c".repeat(200); // 50 tokens
  const windowTokens = 100_000;
  const attentionBudget = { maxFiles: 25, maxTokens: 30_000 };

  function fileDiff(name: string): string {
    return `diff --git a/${name}.js b/${name}.js\n@@ -0,0 +1 @@\n+${"a".repeat(16)}\n`;
  }

  it("splits many small files into attention-sized batches even though the whole diff fits the window", () => {
    const fileCount = 60; // past the 25-file cap, nowhere near the 100k window
    const diff = Array.from({ length: fileCount }, (_, i) => fileDiff(`f${String(i)}`)).join("");
    const whole = planBudget({ prefix, context, diff, windowTokens });
    // sanity: the window alone has no reason to batch this diff
    expect(whole.batchDiff).toBe(false);

    const plan = planBatches(whole, diff, context, prefix, windowTokens, attentionBudget);

    // the attention cap, not the window, drives the split
    expect(plan.diffBatches.length).toBeGreaterThan(1);
    for (const batchDiff of plan.diffBatches) {
      expect(changedFilesFromDiff(batchDiff).length).toBeLessThanOrEqual(attentionBudget.maxFiles);
      expect(approximateTokens(batchDiff)).toBeLessThanOrEqual(attentionBudget.maxTokens);
    }
    // every file survives the split exactly once -- none dropped, none duplicated
    const allFiles = plan.diffBatches.flatMap((batchDiff) => changedFilesFromDiff(batchDiff));
    expect(allFiles.length).toBe(fileCount);
    expect(new Set(allFiles).size).toBe(fileCount);

    // the window had room to spare, so splitting for attention alone is not degradation
    expect(plan.degraded).toBe(false);
    for (const batchContext of plan.batchContexts) expect(batchContext).toBe(context);
    // the notice should name the attention budget, not a window that never bound
    expect(plan.notices.join("\n")).toContain("attention budget");
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
