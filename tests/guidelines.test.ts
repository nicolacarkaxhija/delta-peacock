import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { loadGuidelines } from "../src/guidelines/loader.js";
import { write } from "./helpers/git.js";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "peacock-guidelines-"));
}

const VALID = `---
id: no-console
severity: MAJOR
---
# No console statements

Use the logger instead.
`;

describe("guidelines loader", () => {
  it("parses a valid guideline and derives the title from the heading", () => {
    const dir = makeDir();
    write(dir, "no-console.md", VALID);
    const { guidelines, problems } = loadGuidelines(dir);
    expect(problems).toEqual([]);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0]).toMatchObject({
      id: "no-console",
      severity: "MAJOR",
      title: "No console statements",
    });
  });

  it("prefers an explicit frontmatter title and falls back to the filename", () => {
    const dir = makeDir();
    write(dir, "a.md", "---\nid: a\nseverity: INFO\ntitle: Explicit\n---\nbody\n");
    write(dir, "some-rule.md", "---\nid: b\nseverity: INFO\n---\nno heading here\n");
    const { guidelines } = loadGuidelines(dir);
    const titles = guidelines.map((guideline) => guideline.title).sort();
    expect(titles).toEqual(["Explicit", "some-rule"]);
  });

  it("finds guidelines in nested directories", () => {
    const dir = makeDir();
    write(dir, "frontend/no-inline-style.md", "---\nid: c\nseverity: MINOR\n---\nbody\n");
    expect(loadGuidelines(dir).guidelines).toHaveLength(1);
  });

  it.each([
    { name: "missing id", content: "---\nseverity: MAJOR\n---\nbody\n", needle: '"id"' },
    {
      name: "bad severity",
      content: "---\nid: x\nseverity: HUGE\n---\nbody\n",
      needle: "severity",
    },
    { name: "no frontmatter", content: "# Just markdown\n", needle: "frontmatter" },
    { name: "list frontmatter", content: "---\n- a\n---\nbody\n", needle: "mapping" },
    { name: "broken yaml", content: "---\nid: [unclosed\n---\nbody\n", needle: "frontmatter" },
    {
      name: "unclosed frontmatter",
      content: "---\nid: x\nseverity: INFO\n",
      needle: "frontmatter",
    },
  ])("reports a problem for $name and skips the file", ({ content, needle }) => {
    const dir = makeDir();
    write(dir, "bad.md", content);
    const { guidelines, problems } = loadGuidelines(dir);
    expect(guidelines).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(needle);
  });

  it("keeps the first of two guidelines sharing an id and reports the duplicate", () => {
    const dir = makeDir();
    write(dir, "one.md", "---\nid: dup\nseverity: MAJOR\n---\nfirst\n");
    write(dir, "two.md", "---\nid: dup\nseverity: MINOR\n---\nsecond\n");
    const { guidelines, problems } = loadGuidelines(dir);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0]?.body).toBe("first");
    expect(problems[0]).toContain("duplicate");
  });

  it("ignores files that are not markdown", () => {
    const dir = makeDir();
    write(dir, "notes.txt", "not a guideline\n");
    write(dir, "ok.md", "---\nid: ok\nseverity: INFO\n---\nbody\n");
    const { guidelines, problems } = loadGuidelines(dir);
    expect(guidelines).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("treats a missing directory as a tool error", () => {
    expect(() => loadGuidelines(path.join(makeDir(), "absent"))).toThrow(ToolError);
  });
});

describe("structural frontmatter field", () => {
  it("leaves structural undefined when the field is absent", () => {
    const dir = makeDir();
    write(dir, "no-console.md", VALID);
    const { guidelines } = loadGuidelines(dir);
    expect(guidelines[0]?.structural).toBeUndefined();
  });

  it.each(["no-declaration-in-loop", "module-scope-only"])("accepts structural: %s", (value) => {
    const dir = makeDir();
    write(dir, "rule.md", `---\nid: r\nseverity: MAJOR\nstructural: ${value}\n---\nbody\n`);
    const { guidelines, problems } = loadGuidelines(dir);
    expect(problems).toEqual([]);
    expect(guidelines[0]?.structural).toBe(value);
  });

  it("reports a problem and skips the guideline for an unknown structural value", () => {
    const dir = makeDir();
    write(dir, "rule.md", "---\nid: r\nseverity: MAJOR\nstructural: not-a-real-check\n---\nbody\n");
    const { guidelines, problems } = loadGuidelines(dir);
    expect(guidelines).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("structural");
    expect(problems[0]).toContain("no-declaration-in-loop");
    expect(problems[0]).toContain("module-scope-only");
  });
});

describe("frontmatter contract", () => {
  it("lenient (the default) keeps a guideline missing languages/paths and names the gap", () => {
    const dir = makeDir();
    write(dir, "no-console.md", VALID);
    const { guidelines, problems, notices } = loadGuidelines(dir);
    expect(problems).toEqual([]);
    expect(guidelines).toHaveLength(1);
    const joined = notices.join("\n");
    expect(joined).toContain("no-console");
    expect(joined).toContain("languages");
    expect(joined).toContain("paths");
  });

  it("passing lenient explicitly behaves the same as the default", () => {
    const dir = makeDir();
    write(dir, "no-console.md", VALID);
    const defaulted = loadGuidelines(dir);
    const explicit = loadGuidelines(dir, "lenient");
    expect(explicit.guidelines).toEqual(defaulted.guidelines);
    expect(explicit.notices).toEqual(defaulted.notices);
  });

  it("strict drops a guideline missing languages/paths with a warning naming the gap", () => {
    const dir = makeDir();
    write(dir, "no-console.md", VALID);
    const { guidelines, problems } = loadGuidelines(dir, "strict");
    expect(guidelines).toEqual([]);
    const joined = problems.join("\n");
    expect(joined).toContain("no-console");
    expect(joined).toContain("languages");
    expect(joined).toContain("paths");
    expect(joined).toContain("strict");
  });

  it("emits no notice, in either mode, once languages and paths are both present", () => {
    const dir = makeDir();
    write(
      dir,
      "scoped.md",
      '---\nid: scoped\nseverity: MINOR\nlanguages: [typescript]\npaths: ["src/**"]\n---\nbody\n',
    );
    expect(loadGuidelines(dir).notices).toEqual([]);
    const strict = loadGuidelines(dir, "strict");
    expect(strict.guidelines).toHaveLength(1);
    expect(strict.problems).toEqual([]);
  });

  it("still rejects a malformed languages/paths shape in either mode, not just a missing one", () => {
    const dir = makeDir();
    write(dir, "bad.md", "---\nid: bad\nseverity: MAJOR\nlanguages: python\n---\nbody\n");
    expect(loadGuidelines(dir).problems.join("\n")).toContain('"languages"');
    expect(loadGuidelines(dir, "strict").problems.join("\n")).toContain('"languages"');
  });
});

describe("language field alias (singular)", () => {
  it("accepts a singular string as an alias for languages", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: a\nseverity: MAJOR\nlanguage: javascript\npaths: ["src/**"]\n---\nbody\n',
    );
    const { guidelines, problems, notices } = loadGuidelines(dir);
    expect(problems).toEqual([]);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0]?.languages).toEqual(["javascript"]);
    expect(notices).toEqual([]);
  });

  it("accepts a singular list under the language key", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: a\nseverity: MAJOR\nlanguage: [javascript, isml]\npaths: ["src/**"]\n---\nbody\n',
    );
    const { guidelines, notices } = loadGuidelines(dir);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0]?.languages).toEqual(["javascript", "isml"]);
    expect(notices).toEqual([]);
  });

  it("leaves the plural languages field working unchanged when only it is present", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: a\nseverity: MAJOR\nlanguages: [python]\npaths: ["src/**"]\n---\nbody\n',
    );
    const { guidelines, notices } = loadGuidelines(dir);
    expect(guidelines[0]?.languages).toEqual(["python"]);
    expect(notices).toEqual([]);
  });

  it("prefers languages over language when both are present, with a notice naming the guideline", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: dual\nseverity: MAJOR\nlanguage: javascript\nlanguages: [typescript]\npaths: ["src/**"]\n---\nbody\n',
    );
    const { guidelines, notices } = loadGuidelines(dir);
    expect(guidelines[0]?.languages).toEqual(["typescript"]);
    const joined = notices.join("\n");
    expect(joined).toContain("dual");
    expect(joined).toContain("language");
    expect(joined).toContain("languages");
  });

  it("does not notice a missing languages field when only the singular alias is supplied", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: a\nseverity: MAJOR\nlanguage: javascript\npaths: ["src/**"]\n---\nbody\n',
    );
    expect(loadGuidelines(dir).notices).toEqual([]);
  });

  it("strict mode keeps a guideline scoped only via the singular alias", () => {
    const dir = makeDir();
    write(
      dir,
      "a.md",
      '---\nid: a\nseverity: MAJOR\nlanguage: javascript\npaths: ["src/**"]\n---\nbody\n',
    );
    const { guidelines, problems } = loadGuidelines(dir, "strict");
    expect(guidelines).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("still skips a guideline missing both keys under strict, same as before", () => {
    const dir = makeDir();
    write(dir, "a.md", '---\nid: a\nseverity: MAJOR\npaths: ["src/**"]\n---\nbody\n');
    const { guidelines, problems } = loadGuidelines(dir, "strict");
    expect(guidelines).toEqual([]);
    expect(problems.join("\n")).toContain("languages");
  });

  it("rejects a malformed language value the same way languages is rejected", () => {
    const dir = makeDir();
    write(dir, "bad.md", "---\nid: bad\nseverity: MAJOR\nlanguage: 5\n---\nbody\n");
    expect(loadGuidelines(dir).problems.join("\n")).toContain('"language"');
  });
});
