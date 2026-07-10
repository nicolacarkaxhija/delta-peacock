#!/usr/bin/env node
// Docs integrity checker: every doc under docs/ must be referenced by its
// directory's INDEX.md, and every relative markdown link must resolve.
// Usage: node scripts/check-docs.mjs [repo-root]

import console from "node:console";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? process.cwd());
const problems = [];

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function markdownFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function linkTargets(file) {
  const content = readFileSync(file, "utf8");
  const targets = [];
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto:, ...
    if (raw.startsWith("#")) continue; // in-page anchor
    targets.push(raw.split("#")[0]);
  }
  return targets;
}

const docsFiles = markdownFilesUnder(path.join(root, "docs"));

// Registry rule: each directory under docs/ holding documents needs an
// INDEX.md that references every one of them.
const byDirectory = new Map();
for (const file of docsFiles) {
  const dir = path.dirname(file);
  if (!byDirectory.has(dir)) byDirectory.set(dir, []);
  byDirectory.get(dir).push(file);
}

for (const [dir, files] of byDirectory) {
  const index = path.join(dir, "INDEX.md");
  const documents = files.filter((file) => file !== index);
  if (documents.length === 0) continue;
  if (!existsSync(index)) {
    problems.push(`missing registry: ${relative(dir)} holds documents but no INDEX.md`);
    continue;
  }
  const indexed = new Set(linkTargets(index).map((target) => path.resolve(dir, target)));
  for (const document of documents) {
    if (!indexed.has(document)) {
      problems.push(`orphan: ${relative(document)} is not referenced by ${relative(index)}`);
    }
  }
}

// Link rule: every relative link in the docs tree and the root entry
// documents must point at an existing file.
const linkSources = [
  ...docsFiles,
  path.join(root, "CONTEXT.md"),
  path.join(root, "README.md"),
].filter((file) => existsSync(file));

for (const file of linkSources) {
  for (const target of linkTargets(file)) {
    const resolved = path.resolve(path.dirname(file), target);
    if (!existsSync(resolved)) {
      problems.push(`broken link: ${relative(file)} points at ${target}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\ndocs check failed with ${String(problems.length)} problem(s)`);
  process.exit(1);
}

console.log(`docs check ok (${String(linkSources.length)} files checked)`);
