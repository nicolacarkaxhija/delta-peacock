import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(
    cwd,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-q",
    "-m",
    message,
  );
}

export function write(cwd: string, relPath: string, content: string): void {
  const full = path.join(cwd, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A throwaway repo: main holds a base commit, feature holds one change. */
export function makeRepo(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "peacock-repo-"));
  git(cwd, "init", "-q", "-b", "main");
  write(cwd, "src/app.js", "function greet(name) {\n  return 'hello ' + name;\n}\n");
  commitAll(cwd, "base");
  return cwd;
}

/** A clone of the given repo, wired to it as origin. */
export function cloneRepo(origin: string): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "peacock-clone-"));
  git(cwd, "clone", "-q", origin, ".");
  return cwd;
}

export function headSha(cwd: string): string {
  return git(cwd, "rev-parse", "HEAD").trim();
}
