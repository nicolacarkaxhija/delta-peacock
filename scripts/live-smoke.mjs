#!/usr/bin/env node
// One tiny real review round-trip against the configured live provider.
// Costs a fraction of a cent by construction: one small diff, one guideline,
// a tight diff-size ceiling. Dispatched manually before releases.

import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repo = mkdtempSync(path.join(tmpdir(), "peacock-smoke-"));

function git(...args) {
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

git("init", "-q", "-b", "main");
mkdirSync(path.join(repo, "guidelines"), { recursive: true });
writeFileSync(
  path.join(repo, "guidelines", "no-console.md"),
  "---\nid: no-console\nseverity: MAJOR\n---\n# No console statements\n\nUse the logger instead of console.log.\n",
);
writeFileSync(path.join(repo, "app.js"), "function greet(name) {\n  return name;\n}\n");
git("add", "-A");
git("-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "feature");
writeFileSync(
  path.join(repo, "app.js"),
  "function greet(name) {\n  console.log('greeting', name);\n  return name;\n}\n",
);
git("add", "-A");
git(
  "-c",
  "user.name=smoke",
  "-c",
  "user.email=smoke@example.com",
  "commit",
  "-q",
  "-m",
  "add logging",
);

const report = path.join(repo, "smoke-report.json");
const result = execFileSync(
  process.execPath,
  [cli, "review", "--report", report, "--max-diff-bytes", "20000"],
  {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
  },
);
console.log(result);

const parsed = JSON.parse(readFileSync(report, "utf8"));
console.log(
  `smoke ok: ${String(parsed.findings.length)} finding(s), usage ${JSON.stringify(parsed.usage)}`,
);
if (parsed.findings.length === 0) {
  console.log("note: the model reported no findings for a planted violation; inspect manually");
}
