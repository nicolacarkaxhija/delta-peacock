import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import type { ReviewReport } from "../src/review/report.js";
import { isGitPackSpec, resolvePack } from "../src/guidelines/packs.js";
import { resolveGuidelines } from "../src/guidelines/loader.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const PACK_MANIFEST = `name: sfcc
version: 1.0.0
description: SFCC guidelines
`;

function packRule(id: string, marker: string): string {
  return `---\nid: ${id}\nseverity: MINOR\n---\n# ${id}\n\n${marker}\n`;
}

/** A local pack directory inside the repo, the node_modules-style case. */
function writeLocalPack(repo: string, dir: string, rules: Record<string, string>): void {
  write(repo, `${dir}/pack.yaml`, PACK_MANIFEST);
  for (const [file, content] of Object.entries(rules)) {
    write(repo, `${dir}/${file}`, content);
  }
}

/** A standalone git repo holding a pack; the directory name ends in .git so the file URL is detected as a git spec. */
function makePackRepo(rules: Record<string, string>, manifest = PACK_MANIFEST): string {
  const base = mkdtempSync(path.join(tmpdir(), "peacock-pack-"));
  const dir = path.join(base, "pack.git");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  write(dir, "pack.yaml", manifest);
  for (const [file, content] of Object.entries(rules)) {
    write(dir, file, content);
  }
  commitAll(dir, "pack");
  git(dir, "tag", "v1");
  return dir;
}

describe("git pack spec detection", () => {
  it.each([
    { spec: "https://example.com/team/pack", git: true },
    { spec: "http://example.com/team/pack", git: true },
    { spec: "git://example.com/team/pack", git: true },
    { spec: "https://example.com/team/pack.git#v2", git: true },
    { spec: "vendor/pack.git", git: true },
    { spec: "vendor/pack.git#main", git: true },
    { spec: "vendor/pack.git#", git: true },
    { spec: "vendor/pack", git: false },
    { spec: "node_modules/@scope/pack", git: false },
  ])("$spec -> $git", ({ spec, git: expected }) => {
    expect(isGitPackSpec(spec)).toBe(expected);
  });
});

describe("pack resolution", () => {
  it("resolves a pack from a local path relative to the repo root", () => {
    const repo = makeRepo();
    writeLocalPack(repo, "vendor/sfcc", {
      "no-dw-logger.md": packRule("no-dw-logger", "pack body"),
    });
    const pack = resolvePack(repo, "vendor/sfcc");
    expect(pack.manifest).toEqual({
      name: "sfcc",
      version: "1.0.0",
      description: "SFCC guidelines",
    });
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]?.displayPath).toBe("sfcc:no-dw-logger.md");
  });

  it("clones a pinned git URL shallowly into the cache and reuses it", () => {
    const repo = makeRepo();
    const packRepo = makePackRepo({ "rule.md": packRule("pack-rule", "pinned v1") });
    const spec = `${pathToFileURL(packRepo).href}#v1`;

    const first = resolvePack(repo, spec);
    expect(first.manifest.name).toBe("sfcc");
    expect(first.dir).toContain(path.join(".delta-peacock-cache", "packs"));
    expect(first.files[0]?.content).toContain("pinned v1");

    // the source moves on; the pinned cache must not follow
    write(packRepo, "rule.md", packRule("pack-rule", "moved on"));
    commitAll(packRepo, "drift");
    const second = resolvePack(repo, spec);
    expect(second.dir).toBe(first.dir);
    expect(second.files[0]?.content).toContain("pinned v1");
  });

  it("clones the remote HEAD when the spec pins no ref", () => {
    const repo = makeRepo();
    const packRepo = makePackRepo({ "rule.md": packRule("pack-rule", "head body") });
    const pack = resolvePack(repo, pathToFileURL(packRepo).href);
    expect(pack.files[0]?.content).toContain("head body");
  });

  it("fails loudly and leaves no poisoned cache when the clone fails", () => {
    const repo = makeRepo();
    const spec = "https://127.0.0.1:1/no-such-pack.git#v1";
    expect(() => resolvePack(repo, spec)).toThrow("pack");
    // the second attempt must fail the same way, not trip over a half-clone
    expect(() => resolvePack(repo, spec)).toThrow("pack");
  });

  it("rejects a local pack path that does not exist", () => {
    const repo = makeRepo();
    expect(() => resolvePack(repo, "vendor/nowhere")).toThrow("vendor/nowhere");
  });

  it("rejects a pack without a manifest", () => {
    const repo = makeRepo();
    write(repo, "vendor/bare/rule.md", packRule("r", "b"));
    expect(() => resolvePack(repo, "vendor/bare")).toThrow("pack.yaml");
  });

  it.each([
    { name: "unreadable yaml", manifest: "name: [\n" },
    { name: "not a mapping", manifest: "- just\n- a list\n" },
    { name: "missing name", manifest: "version: 1.0.0\n" },
    { name: "empty name", manifest: 'name: ""\n' },
  ])("rejects a malformed manifest: $name", ({ manifest }) => {
    const repo = makeRepo();
    write(repo, "vendor/bad/pack.yaml", manifest);
    expect(() => resolvePack(repo, "vendor/bad")).toThrow("pack.yaml");
  });

  it("tolerates non-string version and description", () => {
    const repo = makeRepo();
    write(repo, "vendor/loose/pack.yaml", "name: loose\nversion: 2\n");
    expect(resolvePack(repo, "vendor/loose").manifest).toEqual({ name: "loose" });
  });
});

const LOCAL_RULE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nlocal body\n";

describe("pack merge precedence", () => {
  it("loads pack guidelines under the local corpus and records provenance", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/sfcc", {
      "no-dw-logger.md": packRule("no-dw-logger", "pack body"),
    });
    commitAll(repo, "rules");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", ["vendor/sfcc"]);
    expect(resolved.guidelines.map((g) => g.id)).toEqual(["no-dw-logger", "no-console"]);
    expect(resolved.guidelines[0]?.pack).toBe("sfcc");
    expect(resolved.guidelines[1]?.pack).toBeUndefined();
    expect(resolved.notices).toEqual([]);
  });

  it("lets a local guideline win an id collision with a notice naming the losing pack", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/sfcc", {
      "no-console.md": packRule("no-console", "pack version"),
    });
    commitAll(repo, "rules");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", ["vendor/sfcc"]);
    expect(resolved.guidelines).toHaveLength(1);
    expect(resolved.guidelines[0]?.body).toContain("local body");
    expect(resolved.guidelines[0]?.pack).toBeUndefined();
    expect(resolved.notices.join("\n")).toContain("pack sfcc");
    expect(resolved.notices.join("\n")).toContain("no-console");
  });

  it("lets a later pack win over an earlier one with a notice", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/first", { "shared.md": packRule("shared-rule", "first body") });
    write(repo, "vendor/first/pack.yaml", "name: first\n");
    writeLocalPack(repo, "vendor/second", { "shared.md": packRule("shared-rule", "second body") });
    write(repo, "vendor/second/pack.yaml", "name: second\n");
    commitAll(repo, "rules");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", [
      "vendor/first",
      "vendor/second",
    ]);
    const shared = resolved.guidelines.find((g) => g.id === "shared-rule");
    expect(shared?.pack).toBe("second");
    expect(shared?.body).toContain("second body");
    expect(resolved.notices.join("\n")).toContain("pack first");
  });

  it("counts disabled pack guidelines alongside the local corpus", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/sfcc", {
      "off.md": "---\nid: off-rule\nseverity: MINOR\nenabled: false\n---\nbody\n",
    });
    commitAll(repo, "rules");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", ["vendor/sfcc"]);
    expect(resolved.disabled).toBe(1);
    expect(resolved.guidelines.map((g) => g.id)).toEqual(["no-console"]);
  });

  it("carries unusable pack files as problems under the pack name", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/sfcc", { "broken.md": "no frontmatter here\n" });
    commitAll(repo, "rules");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", ["vendor/sfcc"]);
    expect(resolved.problems.join("\n")).toContain("sfcc:broken.md");
  });

  it("reviews from packs alone when no local guidelines directory exists", () => {
    const repo = makeRepo();
    writeLocalPack(repo, "vendor/sfcc", {
      "no-dw-logger.md": packRule("no-dw-logger", "pack body"),
    });
    commitAll(repo, "pack only");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main", ["vendor/sfcc"]);
    expect(resolved.guidelines.map((g) => g.id)).toEqual(["no-dw-logger"]);
    expect(resolved.notices.join("\n")).toContain("guidelines directory not found");
  });

  it("still refuses a pinned guidelines ref without guidelines even when packs exist", () => {
    const repo = makeRepo();
    writeLocalPack(repo, "vendor/sfcc", { "r.md": packRule("r", "b") });
    commitAll(repo, "pack only");
    git(repo, "branch", "-q", "empty-ref");
    expect(() =>
      resolveGuidelines(repo, "empty-ref", "guidelines", "main", ["vendor/sfcc"]),
    ).toThrow("pinned ref");
  });
});

function scriptedModel(text: string): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text, usage: { inputTokens: 10, outputTokens: 5 } });
      },
    },
  };
}

describe("packs end to end", () => {
  it("cites pack guidelines in a review and records the pack in the report", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", LOCAL_RULE);
    writeLocalPack(repo, "vendor/sfcc", {
      "no-dw-logger.md": packRule("no-dw-logger", "Never call dw.system.Logger directly."),
      "no-console.md": packRule("no-console", "pack version that must lose"),
    });
    write(repo, "delta-peacock.config.yaml", "review:\n  packs:\n    - vendor/sfcc\n");
    commitAll(repo, "rules and pack");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
    commitAll(repo, "change");

    const reply = JSON.stringify({
      findings: [
        { guidelineId: "no-dw-logger", file: "src/app.js", line: 2, title: "t", body: "b" },
        { guidelineId: "no-console", file: "src/app.js", line: 2, title: "t", body: "b" },
      ],
    });
    let stdout = "";
    let stderr = "";
    const code = await runCli(["review", "--report", "review.json"], {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      modelPort: scriptedModel(reply).port,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("no-dw-logger");
    expect(stderr).toContain("pack sfcc");

    const report = JSON.parse(readFileSync(path.join(repo, "review.json"), "utf8")) as ReviewReport;
    const packFinding = report.findings.find(
      (f) => f.kind === "violation" && f.guidelineId === "no-dw-logger",
    );
    const localFinding = report.findings.find(
      (f) => f.kind === "violation" && f.guidelineId === "no-console",
    );
    expect(packFinding).toMatchObject({ pack: "sfcc" });
    expect(localFinding).not.toHaveProperty("pack");
    // the collision loser never judges the review: severity comes from the local rule
    expect(localFinding).toMatchObject({ severity: "MAJOR" });
  });
});
