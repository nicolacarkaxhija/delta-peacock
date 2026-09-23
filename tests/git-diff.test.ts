import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { mergeBaseDiff, newLineTexts } from "../src/git/diff.js";
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
