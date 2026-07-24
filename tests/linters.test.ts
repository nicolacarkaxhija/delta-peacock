import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLinters, linterInstruction } from "../src/review/linters.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function capture(): { requests: ModelRequest[]; port: ModelPort } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    },
  };
}

function reviewRepo(extraFiles: Record<string, string> = {}): string {
  const repo = makeRepo();
  write(repo, "guidelines/no-console.md", GUIDELINE);
  for (const [name, content] of Object.entries(extraFiles)) write(repo, name, content);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  commitAll(repo, "change");
  return repo;
}

describe("linter detection", () => {
  it("detects tools by config file presence, sorted for stable bytes", () => {
    const repo = makeRepo();
    write(repo, ".eslintrc.json", "{}");
    write(repo, "biome.json", "{}");
    write(repo, ".prettierrc", "{}");
    expect(detectLinters(repo)).toEqual(["biome", "eslint", "prettier"]);
    expect(detectLinters(makeRepo())).toEqual([]);
  });

  it("renders a stable instruction, empty when nothing is detected", () => {
    expect(linterInstruction([])).toBe("");
    const line = linterInstruction(["eslint", "prettier"]);
    expect(line).toContain("eslint, prettier");
    expect(line).toBe(linterInstruction(["eslint", "prettier"])); // byte-identical
  });
});

describe("linter overlap in the review", () => {
  it("injects one stable prefix line and records the detected tools", async () => {
    const repo = reviewRepo({ "eslint.config.js": "export default [];", ".prettierrc": "{}" });
    const { requests, port } = capture();
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: port,
    });
    expect(code).toBe(0);
    const system = requests[0]?.system ?? "";
    expect(system).toContain("do not raise findings they already cover: eslint, prettier");
    // the instruction sits in the cacheable prefix, ahead of the guidelines
    expect(system.indexOf("already cover")).toBeLessThan(system.indexOf("## Guidelines"));
    expect(stderr).toContain("linters detected (not duplicated): eslint, prettier");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.lintersDetected).toEqual(["eslint", "prettier"]);
  });

  it("adds nothing to the prompt when no linter is configured", async () => {
    const { requests, port } = capture();
    const code = await runCli(["review"], {
      cwd: reviewRepo(),
      env: {},
      out: () => undefined,
      err: () => undefined,
      modelPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).not.toContain("enforce their own rules");
  });
});

describe("guidelines lint machine-checkable warning", () => {
  it("warns on a formatting-style guideline, stays quiet on a real one", async () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/quotes.md",
      "---\nid: quotes\nseverity: MINOR\n---\n# Quotes\n\nUse single quotes for all strings.\n",
    );
    write(repo, "guidelines/logic.md", GUIDELINE);
    commitAll(repo, "rules");
    let stderr = "";
    const code = await runCli(["guidelines", "lint"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: capture().port,
    });
    expect(code).toBe(0); // a warning, not a failure
    expect(stderr).toContain("quotes.md: reads machine-checkable");
    expect(stderr).not.toContain("no-console.md: reads machine-checkable");
  });
});
