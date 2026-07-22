import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/review/prompt.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
const SCOPED =
  "---\nid: backend-only\nseverity: MAJOR\npaths: ['src/backend/**']\n---\n# Backend rule\n\nOnly for backend files.\n";

const CLEAN = JSON.stringify({ findings: [] });

function capture(text: string): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text, usage: { inputTokens: 50, outputTokens: 5 } });
      },
    },
  };
}

function reviewRepo(guidelines: string[] = [GUIDELINE]): string {
  const repo = makeRepo();
  guidelines.forEach((guideline, index) => {
    write(repo, `guidelines/g${String(index)}.md`, guideline);
  });
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  // a backend file keeps path-scoped guidelines inside the reviewed corpus
  write(repo, "src/backend/api.js", "api();\n");
  commitAll(repo, "change");
  return repo;
}

describe("the stable prompt prefix", () => {
  it("keeps guidelines before every volatile section", () => {
    const request = buildReviewPrompt(
      [
        {
          id: "no-console",
          severity: "MAJOR",
          title: "No console",
          body: "Use the logger.",
          languages: [],
          paths: [],
          tags: [],
          sourcePath: "guidelines/no-console.md",
        },
      ],
      "+diff content",
      { generalPass: false, projectContext: "Signature map of related files" },
    );
    const guidelinesAt = request.system.indexOf("## Guidelines");
    const contextAt = request.system.indexOf("## Project context");
    expect(guidelinesAt).toBeGreaterThan(-1);
    expect(contextAt).toBeGreaterThan(-1);
    // the regression this test exists for: volatile content must come last
    expect(guidelinesAt).toBeLessThan(contextAt);
    expect(request.user).toContain("+diff content");
  });
});

describe("guideline scope enforcement after the model answers", () => {
  it("drops a violation citing a guideline that excludes the file", async () => {
    const repo = reviewRepo([GUIDELINE, SCOPED]);
    const reply = JSON.stringify({
      findings: [
        { guidelineId: "no-console", file: "src/app.js", line: 1, title: "Real", body: "b" },
        {
          guidelineId: "backend-only",
          file: "src/app.js",
          line: 1,
          title: "Misapplied",
          body: "b",
        },
      ],
    });
    const { port } = capture(reply);
    let stdout = "";
    const code = await runCli(["review", "--report", "r.json", "--fail-on", "MAJOR"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(2); // the in-scope violation still gates
    expect(stdout).toContain("cited guideline out of scope");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings).toHaveLength(1);
    expect(report.droppedOutOfScopeFindings).toBe(1);
  });
});

describe("the response cache", () => {
  const env = { DELTA_PEACOCK_CACHE_ENABLED: "true" };

  it("serves the second identical review with zero model calls", async () => {
    const repo = reviewRepo();
    const first = capture(CLEAN);
    const one = await runCli(["review", "--report", "r1.json"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: first.port,
    });
    expect(one).toBe(0);
    expect(first.requests).toHaveLength(1);

    const second = capture(CLEAN);
    let stderr = "";
    const two = await runCli(["review", "--report", "r2.json"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: second.port,
    });
    expect(two).toBe(0);
    expect(second.requests).toHaveLength(0); // the cache answered
    expect(stderr).toContain("response cache hit");
    const report = JSON.parse(readFileSync(path.join(repo, "r2.json"), "utf8")) as ReviewReport;
    expect(report.cachedResponse).toBe(true);
    expect(report.usage?.inputTokens).toBe(50); // the stored usage rides along
  });

  it("expires entries past the ttl", async () => {
    const repo = reviewRepo();
    const start = new Date("2026-07-10T12:00:00Z");
    const first = capture(CLEAN);
    await runCli(["review"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: first.port,
      clock: () => start,
    });
    const later = capture(CLEAN);
    await runCli(["review"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: later.port,
      clock: () => new Date(start.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(later.requests).toHaveLength(1); // stale entry re-earned
  });

  it("ignores a corrupted entry and overwrites it", async () => {
    const repo = reviewRepo();
    const first = capture(CLEAN);
    await runCli(["review"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: first.port,
    });
    const { readdirSync, writeFileSync } = await import("node:fs");
    const dir = path.join(repo, ".delta-peacock-cache", "responses");
    const entry = readdirSync(dir)[0] ?? "";
    writeFileSync(path.join(dir, entry), "{broken");
    const second = capture(CLEAN);
    const code = await runCli(["review"], {
      cwd: repo,
      env,
      out: () => undefined,
      err: () => undefined,
      modelPort: second.port,
    });
    expect(code).toBe(0);
    expect(second.requests).toHaveLength(1); // the model answered again
  });

  it("never caches tool-carrying requests and stays off by default", async () => {
    const repo = reviewRepo();
    // agentic context attaches tools, so both runs must call the model
    const agenticEnv = { ...env, DELTA_PEACOCK_CONTEXT_PROVIDER: "agentic" };
    const first = capture(CLEAN);
    await runCli(["review"], {
      cwd: repo,
      env: agenticEnv,
      out: () => undefined,
      err: () => undefined,
      modelPort: first.port,
    });
    const second = capture(CLEAN);
    await runCli(["review"], {
      cwd: repo,
      env: agenticEnv,
      out: () => undefined,
      err: () => undefined,
      modelPort: second.port,
    });
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);

    // and with the cache off (the default), nothing is reused either
    const offRepo = reviewRepo();
    await runCli(["review"], {
      cwd: offRepo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: capture(CLEAN).port,
    });
    const offSecond = capture(CLEAN);
    await runCli(["review"], {
      cwd: offRepo,
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: offSecond.port,
    });
    expect(offSecond.requests).toHaveLength(1);
  });
});
