import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { resolvePack } from "../src/guidelines/packs.js";
import { makeRepo, write } from "./helpers/git.js";

const RULE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";
const NESTED_RULE = "---\nid: no-eval\nseverity: BLOCKER\n---\n# No eval\n\nNever.\n";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function packInit(repo: string, ...args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["guidelines", "pack", "init", ...args], {
    cwd: repo,
    env: {},
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("guidelines pack init", () => {
  it("wraps the guidelines directory into a loadable pack", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE);
    write(repo, "guidelines/security/no-eval.md", NESTED_RULE);

    const { code, stdout } = await packInit(repo, "--name", "team-rules");
    expect(code).toBe(0);
    expect(stdout).toContain("team-rules");

    const pack = resolvePack(repo, path.join("packs", "team-rules"));
    expect(pack.manifest.name).toBe("team-rules");
    expect(pack.manifest.version).toBe("0.1.0");
    expect(pack.files.map((f) => f.displayPath).sort()).toEqual([
      "team-rules:no-console.md",
      "team-rules:security/no-eval.md",
    ]);
  });

  it("honors --dir and --out", async () => {
    const repo = makeRepo();
    write(repo, "rules/no-console.md", RULE);

    const { code } = await packInit(
      repo,
      "--name",
      "custom",
      "--dir",
      "rules",
      "--out",
      "dist/custom-pack",
    );
    expect(code).toBe(0);
    const pack = resolvePack(repo, "dist/custom-pack");
    expect(pack.manifest.name).toBe("custom");
    expect(pack.files).toHaveLength(1);
  });

  it("refuses to clobber an existing output directory without --force", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE);
    write(repo, "packs/team-rules/keep.txt", "precious");

    const { code, stderr } = await packInit(repo, "--name", "team-rules");
    expect(code).toBe(1);
    expect(stderr).toContain("--force");
    expect(readFileSync(path.join(repo, "packs/team-rules/keep.txt"), "utf8")).toBe("precious");
  });

  it("overwrites with --force", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE);
    write(repo, "packs/team-rules/stale.md", "stale");

    const { code } = await packInit(repo, "--name", "team-rules", "--force");
    expect(code).toBe(0);
    expect(existsSync(path.join(repo, "packs/team-rules/stale.md"))).toBe(false);
    expect(resolvePack(repo, "packs/team-rules").files).toHaveLength(1);
  });

  it("fails when the guidelines directory does not exist", async () => {
    const repo = makeRepo();
    const { code, stderr } = await packInit(repo, "--name", "team-rules", "--dir", "nowhere");
    expect(code).toBe(1);
    expect(stderr).toContain("nowhere");
  });

  it("fails when the guidelines directory holds no markdown files", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/notes.txt", "not markdown");
    const { code, stderr } = await packInit(repo, "--name", "team-rules");
    expect(code).toBe(1);
    expect(stderr).toContain("no guideline markdown files");
  });
});
