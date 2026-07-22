import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { loadGuidelinesFromFiles } from "../src/guidelines/loader.js";
import { resolvePack } from "../src/guidelines/packs.js";
import { makeRepo, write } from "./helpers/git.js";

const LEGACY = `---
id: no-hardcoded-secrets
name: No hardcoded secrets
severity: CRITICAL
language: python
---
Credentials never live in source files.
`;

const LEGACY_WITH_H1 = `---
id: use-logger
name: Use the logger
severity: MAJOR
language: javascript
---
# Route output through the logger

console.log does not belong in committed code.
`;

const CONVERTED = `---
id: already-done
severity: MINOR
languages:
  - typescript
---
# Already converted

Body.
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runImport(repo: string, ...args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["guidelines", "import", ...args], {
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

function read(repo: string, rel: string): string {
  return readFileSync(path.join(repo, rel), "utf8");
}

describe("guidelines import", () => {
  it("converts singular language and drops name into the missing H1", async () => {
    const repo = makeRepo();
    write(repo, "legacy/no-hardcoded-secrets.md", LEGACY);

    const { code, stdout } = await runImport(repo, "--from", "legacy");
    expect(code).toBe(0);
    expect(stdout).toContain("1 converted");

    const content = read(repo, "legacy/no-hardcoded-secrets.md");
    expect(content).not.toContain("language:");
    expect(content).toContain("languages:");
    expect(content).toContain("- python");
    expect(content).not.toContain("name:");
    expect(content).toContain("# No hardcoded secrets");
    expect(content).toContain("Credentials never live in source files.");

    const loaded = loadGuidelinesFromFiles([{ displayPath: "x.md", content }]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.guidelines[0]).toMatchObject({
      id: "no-hardcoded-secrets",
      title: "No hardcoded secrets",
      severity: "CRITICAL",
      languages: ["python"],
    });
  });

  it("keeps an existing H1 and still drops the name field", async () => {
    const repo = makeRepo();
    write(repo, "legacy/use-logger.md", LEGACY_WITH_H1);

    const { code } = await runImport(repo, "--from", "legacy");
    expect(code).toBe(0);

    const content = read(repo, "legacy/use-logger.md");
    expect(content).not.toContain("name:");
    expect(content).toContain("# Route output through the logger");
    expect(content).not.toContain("# Use the logger");
    const loaded = loadGuidelinesFromFiles([{ displayPath: "x.md", content }]);
    expect(loaded.guidelines[0]?.title).toBe("Route output through the logger");
    expect(loaded.guidelines[0]?.languages).toEqual(["javascript"]);
  });

  it("is idempotent on already-converted files", async () => {
    const repo = makeRepo();
    write(repo, "legacy/already-done.md", CONVERTED);

    const first = await runImport(repo, "--from", "legacy");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("0 converted");
    expect(first.stdout).toContain("1 already current");
    expect(read(repo, "legacy/already-done.md")).toBe(CONVERTED);
  });

  it("converting twice changes nothing the second time", async () => {
    const repo = makeRepo();
    write(repo, "legacy/rule.md", LEGACY);
    await runImport(repo, "--from", "legacy");
    const once = read(repo, "legacy/rule.md");

    const second = await runImport(repo, "--from", "legacy");
    expect(second.stdout).toContain("0 converted");
    expect(read(repo, "legacy/rule.md")).toBe(once);
  });

  it("drops a redundant language when languages already exists", async () => {
    const repo = makeRepo();
    write(
      repo,
      "legacy/mixed.md",
      "---\nid: mixed\nseverity: MINOR\nlanguage: python\nlanguages: [python]\n---\n# Mixed\n\nBody.\n",
    );
    const { code } = await runImport(repo, "--from", "legacy");
    expect(code).toBe(0);
    const content = read(repo, "legacy/mixed.md");
    expect(content).not.toContain("language: python\n");
    const loaded = loadGuidelinesFromFiles([{ displayPath: "x.md", content }]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.guidelines[0]?.languages).toEqual(["python"]);
  });

  it("writes converted copies to --out and leaves the source untouched", async () => {
    const repo = makeRepo();
    write(repo, "legacy/rule.md", LEGACY);

    const { code } = await runImport(repo, "--from", "legacy", "--out", "guidelines");
    expect(code).toBe(0);
    expect(read(repo, "legacy/rule.md")).toBe(LEGACY);
    expect(read(repo, "guidelines/rule.md")).toContain("languages:");
  });

  it("copies files it cannot convert and reports them as skipped", async () => {
    const repo = makeRepo();
    write(repo, "legacy/readme.md", "No frontmatter at all.\n");
    write(repo, "legacy/rule.md", LEGACY);

    const { code, stdout, stderr } = await runImport(repo, "--from", "legacy", "--out", "out");
    expect(code).toBe(0);
    expect(stdout).toContain("1 skipped");
    expect(stderr).toContain("readme.md");
    expect(read(repo, "out/readme.md")).toBe("No frontmatter at all.\n");
  });

  it("leaves a file with unreadable frontmatter untouched in place", async () => {
    const repo = makeRepo();
    const broken = "---\nname: [\n---\nBody.\n";
    write(repo, "legacy/broken.md", broken);
    const { code, stdout } = await runImport(repo, "--from", "legacy");
    expect(code).toBe(0);
    expect(stdout).toContain("1 skipped");
    expect(read(repo, "legacy/broken.md")).toBe(broken);
  });

  it("fails when the source directory is missing or empty", async () => {
    const repo = makeRepo();
    const missing = await runImport(repo, "--from", "nowhere");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("nowhere");

    write(repo, "empty/.gitkeep", "");
    const empty = await runImport(repo, "--from", "empty");
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("no markdown files");
  });

  it("round-trips: pack init on an imported corpus produces a loadable pack", async () => {
    const repo = makeRepo();
    write(repo, "legacy/no-hardcoded-secrets.md", LEGACY);
    write(repo, "legacy/nested/use-logger.md", LEGACY_WITH_H1);

    expect((await runImport(repo, "--from", "legacy")).code).toBe(0);

    const init = await runCli(
      ["guidelines", "pack", "init", "--name", "migrated", "--dir", "legacy"],
      { cwd: repo, env: {}, out: () => undefined, err: () => undefined },
    );
    expect(init).toBe(0);

    const pack = resolvePack(repo, "packs/migrated");
    expect(pack.manifest.name).toBe("migrated");
    const loaded = loadGuidelinesFromFiles(pack.files);
    expect(loaded.problems).toEqual([]);
    expect(loaded.guidelines.map((g) => g.id).sort()).toEqual([
      "no-hardcoded-secrets",
      "use-logger",
    ]);
    expect(loaded.guidelines.every((g) => g.languages.length === 1)).toBe(true);
  });
});
