import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { mergeBaseDiff, newLineTexts, reindentedLines } from "../src/git/diff.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

describe("merge-base diff", () => {
  it("returns exactly the changes the branch introduces", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/app.js", "function greet(name) {\n  console.log(name);\n  return name;\n}\n");
    commitAll(repo, "change greet");
    const diff = mergeBaseDiff(repo, "main");
    expect(diff).toContain("console.log(name)");
    expect(diff).toContain("src/app.js");
  });

  it("excludes commits that only exist on the target", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "feature.txt", "feature work\n");
    commitAll(repo, "feature work");
    git(repo, "checkout", "-q", "main");
    write(repo, "target-only.txt", "landed on main after branching\n");
    commitAll(repo, "target only");
    git(repo, "checkout", "-q", "feature");
    const diff = mergeBaseDiff(repo, "main");
    expect(diff).toContain("feature.txt");
    expect(diff).not.toContain("target-only.txt");
  });

  it("returns an empty diff when the branch adds nothing", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    expect(mergeBaseDiff(repo, "main")).toBe("");
  });

  it.each([["--upload-pack=evil"], ["-main"], ["ma in"], [""]])("rejects unsafe ref %j", (ref) => {
    expect(() => mergeBaseDiff(makeRepo(), ref)).toThrow(ToolError);
  });

  it("wraps git failures in a ToolError", () => {
    expect(() => mergeBaseDiff(makeRepo(), "no-such-branch")).toThrow(ToolError);
  });

  it("wraps a git invocation with no arguments in a ToolError", async () => {
    const { runGit } = await import("../src/git/git.js");
    expect(() => runGit(makeRepo(), [])).toThrow(ToolError);
  });

  it("wraps a git that cannot even run in a ToolError", () => {
    expect(() => mergeBaseDiff(path.join(makeRepo(), "definitely-missing"), "main")).toThrow(
      ToolError,
    );
  });
});

describe("newLineTexts", () => {
  it("ignores text before the first file header and no-newline markers", () => {
    const diff = [
      "preamble a tool printed",
      "diff --git a/x.js b/x.js",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect([...newLineTexts(diff)]).toEqual([["x.js", new Map([[2, "new"]])]]);
  });
});

describe("reindentedLines", () => {
  it("names the added lines that only change the whitespace of a removed line in the same hunk, one removed line each", () => {
    const diff = [
      "preamble a tool printed",
      "diff --git a/list.js b/list.js",
      "--- a/list.js",
      "+++ b/list.js",
      "@@ -1,5 +1,8 @@",
      " function render(items) {",
      "-  const list = items.map((item) => item.name);",
      '-  return list.join(", ");',
      "-  const total = items.length;",
      "+  if (items.length > 0) {",
      "+    const list = items.map((item) => item.name);",
      '+    return list.join(", ");',
      '+    return list.join(", ");',
      "+\tconst total = items.length;",
      "+  }",
      '+  return "";',
      "\\ No newline at end of file",
      " }",
      "@@ -20,2 +23,2 @@",
      "-  const label = item.name;",
      "+  const label = item.title;",
      "+  const list = items.map((item) => item.name);",
      "diff --git a/other.js b/other.js",
      "--- a/other.js",
      "+++ b/other.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect([...reindentedLines(diff)]).toEqual([
      ["list.js", new Set([3, 4, 6])],
      ["other.js", new Set()],
    ]);
  });

  const oneHunk = (file: string, removed: string[], added: string[]): string =>
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -1,${String(removed.length)} +1,${String(added.length)} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
      "",
    ].join("\n");

  it.each([
    [
      "whitespace inside a string literal",
      "a.js",
      [`  const label = "a b";`],
      [`    const label = "ab";`],
      [],
    ],
    ["two tokens joined", "a.js", ["  return value;"], ["    returnvalue;"], []],
    ["two operators joined", "a.js", ["  total = a - -b;"], ["    total = a--b;"], []],
    ["a brace only line", "a.js", ["  }"], ["    }"], []],
    ["a blank line", "a.js", [""], ["  "], []],
    [
      "a line moved above the lines it followed",
      "a.js",
      ["  first();", "  second();", "  third();"],
      ["    third();", "    first();", "    second();"],
      [2, 3],
    ],
    [
      "a closing brace the change adds",
      "a.js",
      ["  run();", "}"],
      ["  if (ready) {", "    run();", "  }", "}"],
      [2],
    ],
    [
      "a YAML key shifted under a new parent",
      "deploy/config.yaml",
      ["name: web"],
      ["  name: web"],
      [],
    ],
    [
      "a Python statement shifted into a new block",
      "src/report.py",
      ["    return total"],
      ["        return total"],
      [],
    ],
    ["a recipe line shifted in a Makefile", "Makefile", ["\tbuild"], ["\t\tbuild"], []],
  ])(
    "pairs only a word bearing line, in order, with its inner text unchanged, outside whitespace significant files: %s",
    (_, file, removed, added, expected) => {
      expect(reindentedLines(oneHunk(file, removed, added)).get(file)).toEqual(new Set(expected));
    },
  );
});
