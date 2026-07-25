import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { makeRepo, write } from "./helpers/git.js";

async function lint(cwd: string, dir: string): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(["guidelines", "pack", "lint", "--dir", dir], {
    cwd,
    env: {},
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    modelPort: { complete: () => Promise.resolve({ text: "{}" }) },
  });
  return { code, out, err };
}

const GOOD_GUIDELINE =
  "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

describe("guidelines pack lint", () => {
  it("passes a well-formed pack and reports the count", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/pack.yaml", "name: x\nversion: 0.1.0\ndescription: a pack\n");
    write(repo, "packs/x/no-console.md", GOOD_GUIDELINE);
    const { code, out } = await lint(repo, "packs/x");
    expect(code).toBe(0);
    expect(out).toContain("pack ok: x — 1 usable guideline(s)");
  });

  it("fails a pack with no manifest", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/no-console.md", GOOD_GUIDELINE);
    const { code, err } = await lint(repo, "packs/x");
    expect(code).toBe(1);
    expect(err).toContain("pack.yaml not found");
  });

  it("fails a manifest without a name and an unparseable one", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/pack.yaml", "version: 1\n");
    write(repo, "packs/x/g.md", GOOD_GUIDELINE);
    expect((await lint(repo, "packs/x")).err).toContain("needs a non-empty name");

    write(repo, "packs/y/pack.yaml", ":\n  - not: valid: yaml:");
    write(repo, "packs/y/g.md", GOOD_GUIDELINE);
    expect((await lint(repo, "packs/y")).code).toBe(1);
  });

  it("warns on a missing version or description but still passes", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/pack.yaml", "name: x\n");
    write(repo, "packs/x/g.md", GOOD_GUIDELINE);
    const { code, err } = await lint(repo, "packs/x");
    expect(code).toBe(0);
    expect(err).toContain("no version");
    expect(err).toContain("no description");
  });

  it("fails a pack whose guideline is malformed", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/pack.yaml", "name: x\nversion: 1\ndescription: d\n");
    write(
      repo,
      "packs/x/bad.md",
      "---\nid: bad\nseverity: MAJOR\nlanguages: [klingon]\n---\n# Bad\n\nx.\n",
    );
    const { code, err } = await lint(repo, "packs/x");
    expect(code).toBe(1);
    expect(err).toContain('unknown language "klingon"');
  });

  it("warns on a machine-checkable guideline in a pack", async () => {
    const repo = makeRepo();
    write(repo, "packs/x/pack.yaml", "name: x\nversion: 1\ndescription: d\n");
    write(
      repo,
      "packs/x/q.md",
      "---\nid: q\nseverity: MINOR\n---\n# Q\n\nUse single quotes everywhere.\n",
    );
    const { code, err } = await lint(repo, "packs/x");
    expect(code).toBe(0);
    expect(err).toContain("machine-checkable");
  });

  it("fails an empty pack and a missing directory", async () => {
    const repo = makeRepo();
    write(repo, "packs/empty/pack.yaml", "name: empty\nversion: 1\ndescription: d\n");
    expect((await lint(repo, "packs/empty")).err).toContain("no usable guidelines");

    let err = "";
    const code = await runCli(["guidelines", "pack", "lint", "--dir", "packs/nope"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (t) => {
        err += t;
      },
      modelPort: { complete: () => Promise.resolve({ text: "{}" }) },
    });
    expect(code).toBe(1);
    expect(err).toContain("not found");
  });
});

describe("the shipped seed packs", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  it.each(["security", "typescript"])("pack %s lints clean", async (name) => {
    const { code, out } = await lint(repoRoot, path.join("packs", name));
    expect(code).toBe(0);
    expect(out).toContain(`pack ok: ${name}`);
  });
});
