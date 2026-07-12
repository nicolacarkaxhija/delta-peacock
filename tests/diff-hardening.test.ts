import { describe, expect, it } from "vitest";
import { acquireDiff, filterDiffByPath, type DiffRequest } from "../src/git/diff.js";
import { cloneRepo, commitAll, git, headSha, makeRepo, write } from "./helpers/git.js";

function request(overrides: Partial<DiffRequest> = {}): DiffRequest {
  return {
    target: "main",
    fetchTarget: false,
    include: [],
    exclude: [],
    maxDiffBytes: 1_000_000,
    ...overrides,
  };
}

describe("target fetching", () => {
  it("prefers a freshly fetched origin ref over a stale local one", () => {
    const origin = makeRepo();
    const clone = cloneRepo(origin);

    // origin's main moves on after the clone
    write(origin, "landed.txt", "landed on main after the clone\n");
    commitAll(origin, "target moves on");

    // the developer branches in the clone and syncs the new target commit in
    git(clone, "checkout", "-q", "-b", "feature");
    write(clone, "feature.txt", "the actual feature work\n");
    commitAll(clone, "feature work");
    git(clone, "fetch", "-q", "origin");
    git(
      clone,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "merge",
      "-q",
      "--no-edit",
      "origin/main",
    );

    // against the stale local main, the synced target commit pollutes the diff
    const stale = acquireDiff(clone, request({ fetchTarget: false }));
    expect(stale.text).toContain("landed.txt");

    // with fetch on, the diff is judged against origin/main: feature work only
    const fresh = acquireDiff(clone, request({ fetchTarget: true }));
    expect(fresh.targetRef).toBe("origin/main");
    expect(fresh.text).toContain("feature.txt");
    expect(fresh.text).not.toContain("landed.txt");
  });

  it("keeps the cloned origin ref with a notice when the fetch itself fails", async () => {
    const { rmSync } = await import("node:fs");
    const origin = makeRepo();
    const clone = cloneRepo(origin);
    git(clone, "checkout", "-q", "-b", "feature");
    write(clone, "f.txt", "x\n");
    commitAll(clone, "f");
    rmSync(origin, { recursive: true, force: true });
    const acquired = acquireDiff(clone, request({ fetchTarget: true }));
    expect(acquired.notices.join("\n")).toContain("could not fetch");
    expect(acquired.targetRef).toBe("origin/main");
    expect(acquired.text).toContain("f.txt");
  });

  it("notes when the requested target exists on no remote", async () => {
    const { resolveTargetRef } = await import("../src/git/diff.js");
    const clone = cloneRepo(makeRepo());
    const resolved = resolveTargetRef(clone, "develop", true);
    expect(resolved.ref).toBe("develop");
    expect(resolved.notices.join("\n")).toContain("origin/develop not found");
  });

  it("falls back to the local ref outside any remote with no noise", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "f.txt", "x\n");
    commitAll(repo, "f");
    const acquired = acquireDiff(repo, request({ fetchTarget: true }));
    expect(acquired.targetRef).toBe("main");
    expect(acquired.text).toContain("f.txt");
    expect(acquired.notices).toEqual([]);
  });
});

describe("incremental anchor", () => {
  it("reviews only changes after the anchor when it is still reachable", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "first.txt", "first commit\n");
    commitAll(repo, "first");
    const anchor = headSha(repo);
    write(repo, "second.txt", "second commit\n");
    commitAll(repo, "second");

    const acquired = acquireDiff(repo, request({ lastReviewedCommit: anchor }));
    expect(acquired.mode).toBe("incremental");
    expect(acquired.text).toContain("second.txt");
    expect(acquired.text).not.toContain("first.txt");
  });

  it("falls back to a full review when target commits were merged in after the anchor", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "first.txt", "first\n");
    commitAll(repo, "first");
    const anchor = headSha(repo);

    // the target moves on and the developer syncs it into the branch
    git(repo, "checkout", "-q", "main");
    write(repo, "target-only.txt", "landed on main\n");
    commitAll(repo, "target moves");
    git(repo, "checkout", "-q", "feature");
    git(
      repo,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "merge",
      "-q",
      "--no-edit",
      "main",
    );
    write(repo, "second.txt", "after the sync\n");
    commitAll(repo, "second");

    const acquired = acquireDiff(repo, request({ lastReviewedCommit: anchor }));
    expect(acquired.mode).toBe("full");
    expect(acquired.notices.join("\n")).toContain("target moved into this branch");
    expect(acquired.text).not.toContain("target-only.txt");
    expect(acquired.text).toContain("second.txt");
  });

  it("falls back to a full review when the anchor does not resolve at all", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "first.txt", "first\n");
    commitAll(repo, "first");
    const acquired = acquireDiff(repo, request({ lastReviewedCommit: "deadbeefdeadbeef" }));
    expect(acquired.mode).toBe("full");
    expect(acquired.text).toContain("first.txt");
  });

  it("falls back to a full review when a rebase strands the anchor", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "first.txt", "first commit\n");
    commitAll(repo, "first");
    const anchor = headSha(repo);

    // the target moves on, then the feature is rebased onto it
    git(repo, "checkout", "-q", "main");
    write(repo, "main-moves.txt", "target only\n");
    commitAll(repo, "target moves");
    git(repo, "checkout", "-q", "feature");
    git(
      repo,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "rebase",
      "-q",
      "main",
    );

    const acquired = acquireDiff(repo, request({ lastReviewedCommit: anchor }));
    expect(acquired.mode).toBe("full");
    expect(acquired.notices.join("\n")).toContain("rebase");
    expect(acquired.text).toContain("first.txt");
    expect(acquired.text).not.toContain("main-moves.txt");
  });
});

describe("path filtering and the size ceiling", () => {
  const twoFileDiff = [
    "diff --git a/src/app.js b/src/app.js",
    "index 111..222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1 +1 @@",
    "+real change",
    "diff --git a/vendor/lib.js b/vendor/lib.js",
    "index 333..444 100644",
    "--- a/vendor/lib.js",
    "+++ b/vendor/lib.js",
    "@@ -1 +1 @@",
    "+vendored change",
    "",
  ].join("\n");

  it("drops excluded paths and keeps the rest intact", () => {
    const filtered = filterDiffByPath(twoFileDiff, [], ["vendor/**"]);
    expect(filtered).toContain("src/app.js");
    expect(filtered).not.toContain("vendor/lib.js");
  });

  it("keeps only included paths when include globs are set", () => {
    const filtered = filterDiffByPath(twoFileDiff, ["vendor/**"], []);
    expect(filtered).toContain("vendor/lib.js");
    expect(filtered).not.toContain("src/app.js");
  });

  it("filters excluded files out of the acquired diff", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "vendor/lib.js", "vendored\n");
    write(repo, "src/real.js", "real\n");
    commitAll(repo, "mixed");
    const acquired = acquireDiff(repo, request({ exclude: ["vendor/**"] }));
    expect(acquired.text).toContain("src/real.js");
    expect(acquired.text).not.toContain("vendor/lib.js");
  });

  it("filters quoted non-ascii paths correctly", () => {
    const quoted = [
      'diff --git "a/vendor/f\\303\\266\\303\\266.js" "b/vendor/f\\303\\266\\303\\266.js"',
      "index 111..222 100644",
      "+quoted vendored change",
      "diff --git a/src/real.js b/src/real.js",
      "index 333..444 100644",
      "+real change",
      "",
    ].join("\n");
    const filtered = filterDiffByPath(quoted, [], ["vendor/**"]);
    expect(filtered).not.toContain("quoted vendored change");
    expect(filtered).toContain("real change");
  });

  it("keeps chunks whose header it cannot parse rather than dropping them", () => {
    const odd = "diff --git strange header format\n+something\n";
    expect(filterDiffByPath(odd, [], ["**"])).toBe(odd);
  });

  it("skips the review over the byte ceiling instead of truncating", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "big.txt", "x".repeat(5000));
    commitAll(repo, "big");
    const acquired = acquireDiff(repo, request({ maxDiffBytes: 100 }));
    expect(acquired.skipped).toBe("too-large");
    expect(acquired.text).toBe("");
    expect(acquired.notices.join("\n")).toContain("ceiling");
  });
});
