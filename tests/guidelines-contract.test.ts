import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { appliesTo } from "../src/guidelines/languages.js";
import { runGuidelinesLint } from "../src/guidelines/lint.js";
import { resolveGuidelines } from "../src/guidelines/loader.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

function guideline(overrides: Partial<Guideline> = {}): Guideline {
  return {
    id: "g",
    severity: "MAJOR",
    title: "t",
    body: "b",
    sourcePath: "g.md",
    languages: [],
    paths: [],
    tags: [],
    ...overrides,
  };
}

describe("applicability", () => {
  it.each([
    { name: "no scoping applies everywhere", g: {}, files: ["x.py"], applies: true },
    {
      name: "language matches by extension",
      g: { languages: ["typescript"] },
      files: ["src/a.ts"],
      applies: true,
    },
    {
      name: "language mismatch drops the guideline",
      g: { languages: ["python"] },
      files: ["src/a.ts"],
      applies: false,
    },
    {
      name: "path glob scopes the guideline",
      g: { paths: ["src/api/**"] },
      files: ["src/api/users.ts"],
      applies: true,
    },
    {
      name: "path glob mismatch drops it",
      g: { paths: ["src/api/**"] },
      files: ["docs/readme.md"],
      applies: false,
    },
    {
      name: "language and path must both match",
      g: { languages: ["typescript"], paths: ["src/**"] },
      files: ["src/a.py"],
      applies: false,
    },
    {
      name: "unknown language matches nothing",
      g: { languages: ["klingon"] },
      files: ["a.ts"],
      applies: false,
    },
  ])("$name", ({ g, files, applies }) => {
    expect(appliesTo(guideline(g), files)).toBe(applies);
  });
});

const RULE_V1 = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nBody v1.\n";
const RULE_V2_WEAKENED = "---\nid: no-console\nseverity: INFO\n---\n# No console\n\nweakened\n";

describe("resolveGuidelines", () => {
  it("reads from the target ref so branch edits cannot weaken the rules", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE_V1);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "guidelines/no-console.md", RULE_V2_WEAKENED);
    commitAll(repo, "weaken the rule");

    const resolved = resolveGuidelines(repo, "target", "guidelines", "main");
    expect(resolved.origin).toBe("main");
    expect(resolved.guidelines[0]?.severity).toBe("MAJOR");
    expect(resolved.guidelines[0]?.body).toContain("Body v1.");
  });

  it("honors source mode by reading the working tree", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE_V1);
    commitAll(repo, "rules");
    write(repo, "guidelines/no-console.md", RULE_V2_WEAKENED);

    const resolved = resolveGuidelines(repo, "source", "guidelines", "main");
    expect(resolved.origin).toBe("working tree");
    expect(resolved.guidelines[0]?.severity).toBe("INFO");
  });

  it("falls back to the working tree with a notice while bootstrapping", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE_V1);
    // not committed anywhere: the PR introducing guidelines
    const resolved = resolveGuidelines(repo, "target", "guidelines", "main");
    expect(resolved.origin).toBe("working tree");
    expect(resolved.notices.join("\n")).toContain("bootstrapping");
    expect(resolved.guidelines).toHaveLength(1);
  });

  it("refuses to fall back when an explicitly pinned ref has no guidelines", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE_V1);
    git(repo, "branch", "-q", "empty-ref");
    expect(() => resolveGuidelines(repo, "empty-ref", "guidelines", "main")).toThrow("pinned ref");
  });

  it("reads from an explicitly pinned ref", () => {
    const repo = makeRepo();
    write(repo, "guidelines/no-console.md", RULE_V1);
    commitAll(repo, "rules");
    git(repo, "branch", "-q", "pinned");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "guidelines/no-console.md", RULE_V2_WEAKENED);
    commitAll(repo, "weaken");
    const resolved = resolveGuidelines(repo, "pinned", "guidelines", "main");
    expect(resolved.origin).toBe("pinned");
    expect(resolved.guidelines[0]?.severity).toBe("MAJOR");
  });

  it("skips disabled guidelines and counts them", () => {
    const repo = makeRepo();
    write(repo, "guidelines/off.md", "---\nid: off\nseverity: MAJOR\nenabled: false\n---\nbody\n");
    write(repo, "guidelines/on.md", "---\nid: on\nseverity: MAJOR\n---\nbody\n");
    commitAll(repo, "rules");
    const resolved = resolveGuidelines(repo, "target", "guidelines", "main");
    expect(resolved.guidelines.map((g) => g.id)).toEqual(["on"]);
    expect(resolved.disabled).toBe(1);
  });
});

function lint(repo: string): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runGuidelinesLint(
    {
      cwd: repo,
      env: {},
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    {},
  );
  return { code, stdout, stderr };
}

describe("guidelines lint", () => {
  it("passes a clean corpus and reports counts", () => {
    const repo = makeRepo();
    write(
      repo,
      "guidelines/a.md",
      "---\nid: a\nseverity: MAJOR\nlanguages: [typescript]\n---\nbody\n",
    );
    write(repo, "guidelines/off.md", "---\nid: off\nseverity: INFO\nenabled: false\n---\nbody\n");
    const { code, stdout } = lint(repo);
    expect(code).toBe(0);
    expect(stdout).toContain("1 usable");
    expect(stdout).toContain("1 disabled");
  });

  it("fails listing every structural problem with its file", () => {
    const repo = makeRepo();
    write(repo, "guidelines/dup1.md", "---\nid: dup\nseverity: MAJOR\n---\nbody\n");
    write(repo, "guidelines/dup2.md", "---\nid: dup\nseverity: MAJOR\n---\nbody\n");
    write(repo, "guidelines/bad-sev.md", "---\nid: b\nseverity: HUGE\n---\nbody\n");
    write(repo, "guidelines/no-id.md", "---\nseverity: MAJOR\n---\nbody\n");
    write(repo, "guidelines/empty.md", "---\nid: e\nseverity: MINOR\n---\n\n");
    write(
      repo,
      "guidelines/lang.md",
      "---\nid: l\nseverity: MINOR\nlanguages: [klingon]\n---\nbody\n",
    );
    const { code, stderr } = lint(repo);
    expect(code).toBe(1);
    expect(stderr).toContain("dup2.md");
    expect(stderr).toContain("bad-sev.md");
    expect(stderr).toContain("no-id.md");
    expect(stderr).toContain("empty.md");
    expect(stderr).toContain('unknown language "klingon"');
    expect(stderr).toContain("5 problem(s)");
  });

  it.each([
    { name: "enabled not boolean", fm: "enabled: sometimes", needle: '"enabled"' },
    { name: "languages not a list", fm: "languages: python", needle: '"languages"' },
    { name: "paths not a list", fm: "paths: 5", needle: '"paths"' },
    { name: "tags not a list", fm: "tags: {a: 1}", needle: '"tags"' },
  ])("rejects malformed scoping: $name", ({ fm, needle }) => {
    const repo = makeRepo();
    write(repo, "guidelines/bad.md", `---\nid: bad\nseverity: MAJOR\n${fm}\n---\nbody\n`);
    const { code, stderr } = lint(repo);
    expect(code).toBe(1);
    expect(stderr).toContain(needle);
  });

  it("propagates a missing directory as a tool error", () => {
    const repo = makeRepo();
    expect(() =>
      runGuidelinesLint(
        { cwd: path.join(repo), env: {}, out: () => undefined, err: () => undefined },
        { "review.guidelinesDir": "nowhere" },
      ),
    ).toThrow("guidelines directory not found");
  });
});
