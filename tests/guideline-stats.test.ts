import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stalenessOf, treeFiles } from "../src/commands/guideline-stats.js";
import { runCli } from "../src/index.js";
import type { StatsRecord } from "../src/stats/record.js";
import { commitAll, makeRepo, write } from "./helpers/git.js";

const NO_CONSOLE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
const PY_ONLY =
  "---\nid: py-only\nseverity: MAJOR\nlanguages: [python]\n---\n# Py\n\nPython rule.\n";
const BACKEND_ONLY =
  "---\nid: backend-only\nseverity: MAJOR\npaths: ['src/backend/**']\n---\n# Backend\n\nBackend rule.\n";

function ledger(cwd: string, records: StatsRecord[]): void {
  writeFileSync(
    path.join(cwd, "delta-peacock.stats.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

async function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await runCli(args, {
    cwd,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: () => undefined,
    modelPort: { complete: () => Promise.resolve({ text: "{}" }) },
  });
  return { code, stdout };
}

describe("guidelines stats", () => {
  it("reports fire counts, last-fired and never-fired from the ledger", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", NO_CONSOLE);
    write(repo, "guidelines/unused.md", "---\nid: unused\nseverity: MINOR\n---\n# Unused\n\nx.\n");
    commitAll(repo, "rules");
    ledger(repo, [
      {
        at: "2026-07-01T00:00:00Z",
        author: "a",
        addedLines: 5,
        bySeverity: {},
        byGuideline: { "no-console": 2 },
      },
      {
        at: "2026-07-09T00:00:00Z",
        author: "a",
        addedLines: 5,
        bySeverity: {},
        byGuideline: { "no-console": 1 },
      },
    ]);
    const { code, stdout } = await run(repo, ["guidelines", "stats", "--report", "g.json"]);
    expect(code).toBe(0);
    expect(stdout).toContain("no-console: 3 fire(s), last 2026-07-09T00:00:00Z");
    expect(stdout).toContain("unused: 0 fire(s)  [never fired]");
    const report = JSON.parse(readFileSync(path.join(repo, "g.json"), "utf8")) as {
      guidelines: { id: string; fires: number; lastFired?: string }[];
    };
    expect(report.guidelines[0]).toMatchObject({ id: "no-console", fires: 3 });
  });

  it("flags a guideline whose language no longer exists in the tree", async () => {
    const repo = makeRepo(); // the fixture tree is javascript only
    write(repo, "guidelines/py-only.md", PY_ONLY);
    commitAll(repo, "rules");
    const { stdout } = await run(repo, ["guidelines", "stats"]);
    expect(stdout).toContain("py-only");
    expect(stdout).toContain("stale languages");
  });

  it("flags a guideline whose path scope matches nothing", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/backend-only.md", BACKEND_ONLY);
    commitAll(repo, "rules");
    const { stdout } = await run(repo, ["guidelines", "stats"]);
    expect(stdout).toContain("backend-only");
    expect(stdout).toContain("stale paths");
  });

  it("does not flag a scope that still matches, and works with no history", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/backend-only.md", BACKEND_ONLY);
    write(repo, "src/backend/api.js", "api();\n");
    commitAll(repo, "rules");
    const { code, stdout } = await run(repo, ["guidelines", "stats"]);
    expect(code).toBe(0); // empty ledger is informative, not an error
    expect(stdout).toContain("backend-only: 0 fire(s)  [never fired]");
    expect(stdout).not.toContain("stale paths");
  });

  it("says so when the corpus is empty", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/.keep", "");
    commitAll(repo, "empty");
    const { stdout } = await run(repo, ["guidelines", "stats"]);
    expect(stdout).toContain("no guidelines found");
  });
});

describe("staleness and tree walking", () => {
  it("treats a declared-but-empty scope as stale, a matched one as fresh", () => {
    const guideline = {
      id: "g",
      title: "t",
      body: "b",
      severity: "MAJOR" as const,
      sourcePath: "guidelines/g.md",
      languages: ["python"],
      paths: ["src/**"],
      tags: [],
    };
    expect(stalenessOf(guideline, ["src/app.py"])).toEqual({
      stalePaths: false,
      staleLanguages: false,
    });
    expect(stalenessOf(guideline, ["src/app.js"])).toEqual({
      stalePaths: false,
      staleLanguages: true,
    });
    expect(stalenessOf(guideline, ["docs/readme.md"])).toEqual({
      stalePaths: true,
      staleLanguages: true,
    });
    // a guideline declaring no scope is never stale
    expect(stalenessOf({ ...guideline, languages: [], paths: [] }, [])).toEqual({
      stalePaths: false,
      staleLanguages: false,
    });
  });

  it("walks the tree, skipping vendored and dotted directories", () => {
    const repo = makeRepo();
    write(repo, "src/a.js", "a();\n");
    write(repo, "node_modules/dep/index.js", "x();\n");
    write(repo, ".secret/token", "x\n");
    const files = treeFiles(repo);
    expect(files).toContain("src/a.js");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.includes(".secret"))).toBe(false);
  });
});
