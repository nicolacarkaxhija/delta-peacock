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
