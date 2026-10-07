import { describe, expect, it } from "vitest";
import { resolveGuidelines } from "../src/guidelines/loader.js";
import { guidelineSources } from "../src/review/guideline-sources.js";
import { commitAll, git, headSha, makeRepo, write } from "./helpers/git.js";

const RULE = "---\nid: no-console\nseverity: MAJOR\n---\n# No console\n\nUse the logger.\n";

function repoWithRule(): string {
  const repo = makeRepo();
  write(repo, "guidelines/logging/g0.md", RULE);
  commitAll(repo, "rules");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "console.log('x');\n");
  commitAll(repo, "change");
  return repo;
}

describe("where each guideline's file lives", () => {
  it("names the real file on the target and the target's commit", () => {
    const repo = repoWithRule();
    const loaded = resolveGuidelines(repo, "target", "guidelines", "main");
    expect(guidelineSources(repo, loaded, headSha(repo))).toEqual(
      new Map([
        [
          "no-console",
          { path: "guidelines/logging/g0.md", commit: git(repo, "rev-parse", "main").trim() },
        ],
      ]),
    );
  });

  it("names the working tree file at the reviewed commit", () => {
    const repo = repoWithRule();
    const loaded = resolveGuidelines(repo, "source", "guidelines", "main");
    expect(guidelineSources(repo, loaded, headSha(repo)).get("no-console")).toEqual({
      path: "guidelines/logging/g0.md",
      commit: headSha(repo),
    });
  });

  it("knows no file for a pack guideline, a local directory or a missing commit", () => {
    const repo = repoWithRule();
    const loaded = resolveGuidelines(repo, "source", "guidelines", "main");
    const packed = {
      ...loaded,
      guidelines: loaded.guidelines.map((rule) => ({ ...rule, pack: "team" })),
    };
    expect(guidelineSources(repo, packed, headSha(repo)).size).toBe(0);
    expect(
      guidelineSources(repo, { ...loaded, origin: `local:${repo}/guidelines` }, headSha(repo)).size,
    ).toBe(0);
    expect(guidelineSources(repo, loaded, undefined).size).toBe(0);
    expect(guidelineSources(repo, { ...loaded, origin: "gone-ref" }, headSha(repo)).size).toBe(0);
    // a file read from another ref, or from outside the repository, has no address here
    expect(guidelineSources(repo, { ...loaded, origin: "main" }, headSha(repo)).size).toBe(0);
    const outside = {
      ...loaded,
      guidelines: loaded.guidelines.map((rule) => ({ ...rule, sourcePath: "/elsewhere/g0.md" })),
    };
    expect(guidelineSources(repo, outside, headSha(repo)).size).toBe(0);
  });
});
