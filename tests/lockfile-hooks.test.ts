import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitAll, headSha, makeRepo, write } from "./helpers/git.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NULL_SHA = "0".repeat(40);

interface Fixture {
  repo: string;
  run: (hook: string, ...args: string[]) => void;
  installed: () => boolean;
}

/** A repo holding the real hooks, with a fake pnpm on PATH that records each call. */
function fixture(): Fixture {
  const repo = makeRepo();
  for (const file of [
    ".husky/post-checkout",
    ".husky/post-merge",
    "scripts/install-if-lockfile-changed.sh",
  ]) {
    cpSync(path.join(ROOT, file), path.join(repo, file));
  }
  const bin = mkdtempSync(path.join(tmpdir(), "peacock-bin-"));
  const marker = path.join(bin, "calls");
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$@" >> "${marker}"\n`);
  chmodSync(path.join(bin, "pnpm"), 0o755);
  return {
    repo,
    run: (hook, ...args) => {
      execFileSync("sh", [`.husky/${hook}`, ...args], {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` },
        stdio: "pipe",
      });
    },
    installed: () => existsSync(marker) && readFileSync(marker, "utf8").includes("install"),
  };
}

/** Commits a change and returns the shas before and after it. */
function change(repo: string, file: string): [string, string] {
  const before = headSha(repo);
  write(repo, file, `${Math.random().toString()}\n`);
  commitAll(repo, `change ${file}`);
  return [before, headSha(repo)];
}

describe.skipIf(process.platform === "win32")("lockfile install hooks", () => {
  it("post-checkout installs when a branch switch changes the lockfile", () => {
    const { repo, run, installed } = fixture();
    run("post-checkout", ...change(repo, "pnpm-lock.yaml"), "1");
    expect(installed()).toBe(true);
  });

  it("post-checkout is a no-op when the lockfile did not change", () => {
    const { repo, run, installed } = fixture();
    run("post-checkout", ...change(repo, "src/other.js"), "1");
    expect(installed()).toBe(false);
  });

  it("post-checkout ignores a file checkout", () => {
    const { repo, run, installed } = fixture();
    run("post-checkout", ...change(repo, "pnpm-lock.yaml"), "0");
    expect(installed()).toBe(false);
  });

  it("post-checkout skips the null sha of a fresh clone", () => {
    const { repo, run, installed } = fixture();
    run("post-checkout", NULL_SHA, headSha(repo), "1");
    expect(installed()).toBe(false);
  });

  it("post-merge installs when the merge brought a lockfile change", () => {
    const { repo, run, installed } = fixture();
    change(repo, "pnpm-lock.yaml");
    run("post-merge", "0");
    expect(installed()).toBe(true);
  });

  it("post-merge is a no-op when the lockfile did not change", () => {
    const { repo, run, installed } = fixture();
    change(repo, "src/other.js");
    run("post-merge", "0");
    expect(installed()).toBe(false);
  });
});
