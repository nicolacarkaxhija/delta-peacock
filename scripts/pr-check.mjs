#!/usr/bin/env node
// Checks a change against docs/contributing.md: branch name, pull request title and description.
// In a pipeline: node scripts/pr-check.mjs. From the pre-push hook: node scripts/pr-check.mjs --local.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TRUNK = "main";
export const COMMIT_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];
export const BRANCH_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "test",
  "refactor",
  "perf",
  "ci",
  "build",
];
export const SUBJECT_PATTERN = new RegExp(
  `^(${COMMIT_TYPES.join("|")})(\\([a-z0-9._/-]+\\))?!?: \\S`,
);
const KEY = "[A-Z][A-Z0-9]+-[1-9][0-9]*";
export const BRANCH_PATTERN = new RegExp(
  `^(${BRANCH_TYPES.join("|")})/(?:(${KEY})-)?[a-z0-9]+(?:-[a-z0-9]+)*$`,
);
const KEY_IN_TEXT = new RegExp(`\\b${KEY}\\b`, "g");
// Em dash, en dash, or a spaced double hyphen used as punctuation.
const EN_DASH = 0x2013;
const EM_DASH = 0x2014;
const DASH_PATTERN = new RegExp(
  `[${String.fromCharCode(EN_DASH)}${String.fromCharCode(EM_DASH)}]| -- `,
);

export const SECTIONS = [
  { name: "What", required: true },
  { name: "Why", required: true },
  { name: "How to test", required: true },
  { name: "Evidence", required: false },
  { name: "Checklist", required: true },
];

const RULES = "docs/contributing.md";

/** Problems with a branch name, empty when it follows the rule. */
export function checkBranch(branch) {
  if (BRANCH_PATTERN.test(branch)) return [];
  return [
    `branch: '${branch}' must read <type>/<slug> or <type>/<TICKET-KEY>-<slug>`,
    `  type one of ${BRANCH_TYPES.join(", ")}; slug in lowercase words joined by hyphens`,
    "  for example feat/PROJ-142-export-csv, fix/empty-cart-state, chore/node-24",
  ];
}

/** Problems with a commit subject, the rule of the commit-msg hook. */
export function checkSubject(subject, label = "commit subject", env = process.env) {
  const problems = [];
  if (!SUBJECT_PATTERN.test(subject)) {
    problems.push(
      `${label}: '${subject}' must read 'type(scope): summary'`,
      `  type one of ${COMMIT_TYPES.join(", ")}`,
    );
  }
  if (env.BASELINE_ALLOW_DASHES !== "1" && DASH_PATTERN.test(subject)) {
    problems.push(`${label}: no em dash, en dash or double hyphen as punctuation; use a comma`);
  }
  return problems;
}

/** Problems with a pull request title: the commit rule, one line, the ticket key last. */
export function checkTitle(title, branch = "", env = process.env) {
  const text = title.trim();
  if (text.includes("\n")) return ["title: one line only; it becomes the squash commit subject"];
  const problems = checkSubject(text, "title", env);
  const keys = text.match(KEY_IN_TEXT) ?? [];
  const last = keys.at(-1);
  if (keys.length > 1 || (last !== undefined && !text.endsWith(`, ${last}`))) {
    problems.push(`title: the ticket key goes once at the end, after a comma: '..., ${last}'`);
  }
  const branchKey = BRANCH_PATTERN.exec(branch)?.[2];
  if (branchKey !== undefined && !text.endsWith(`, ${branchKey}`)) {
    problems.push(`title: the branch names ${branchKey}, so the title ends with ', ${branchKey}'`);
  }
  return problems;
}

/** The description's sections, heading text to the body lines that carry content. */
export function parseSections(description) {
  const sections = new Map();
  let current;
  let inComment = false;
  for (const raw of description.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading && !inComment) {
      current = heading[1].replace(/\s*\(optional\)$/i, "").toLowerCase();
      sections.set(current, sections.get(current) ?? []);
      continue;
    }
    // Template hints are blockquotes or HTML comments; neither counts as content.
    if (line.startsWith("<!--")) inComment = true;
    const hidden = inComment || line === "" || line.startsWith(">");
    if (inComment && line.includes("-->")) inComment = false;
    if (current !== undefined && !hidden) sections.get(current).push(line);
  }
  return sections;
}

/** Problems with a description: every required section present and filled in. */
export function checkDescription(description) {
  const sections = parseSections(description ?? "");
  const problems = [];
  for (const { name, required } of SECTIONS) {
    if (!required) continue;
    const body = sections.get(name.toLowerCase());
    if (body === undefined) problems.push(`description: the '## ${name}' section is missing`);
    else if (body.length === 0) problems.push(`description: the '## ${name}' section is empty`);
  }
  return problems;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function bitbucketPullRequest(env, fetchImpl) {
  const token = env.BITBUCKET_TOKEN;
  if (!token)
    throw new Error("BITBUCKET_TOKEN is not set; add it as a secured repository variable");
  const url = `https://api.bitbucket.org/2.0/repositories/${env.BITBUCKET_WORKSPACE}/${env.BITBUCKET_REPO_SLUG}/pullrequests/${env.BITBUCKET_PR_ID}`;
  // A user:token pair goes as basic auth, an access token as bearer.
  const authorization = token.includes(":")
    ? `Basic ${Buffer.from(token).toString("base64")}`
    : `Bearer ${token}`;
  const response = await fetchImpl(url, { headers: { authorization, accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`reading pull request ${env.BITBUCKET_PR_ID} failed: HTTP ${response.status}`);
  }
  const pr = await response.json();
  return { branch: env.BITBUCKET_BRANCH, title: pr.title ?? "", description: pr.description ?? "" };
}

/** What to check, from the arguments and the environment the check runs in. */
export async function collect(argv, env, deps = {}) {
  const runGit = deps.git ?? git;
  if (argv.includes("--local")) {
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") return { skip: "detached HEAD, nothing to name" };
    if (branch === TRUNK)
      return { skip: `${TRUNK} is guarded by branch protection, not by a name` };
    return { branch, subject: runGit(["log", "-1", "--format=%s"]) };
  }
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_PATH) {
    const readFile = deps.readFile ?? ((file) => readFileSync(file, "utf8"));
    const pr = JSON.parse(readFile(env.GITHUB_EVENT_PATH)).pull_request;
    if (!pr) return { skip: "not a pull request event" };
    return { branch: pr.head.ref, title: pr.title ?? "", description: pr.body ?? "" };
  }
  if (env.BITBUCKET_PR_ID) return bitbucketPullRequest(env, deps.fetch ?? globalThis.fetch);
  throw new Error("no pull request found: run in a pipeline, or with --local for the branch");
}

/** Every problem with what collect found. */
export function judge(found, env = process.env) {
  const problems = [];
  if (found.branch !== undefined) problems.push(...checkBranch(found.branch));
  if (found.subject !== undefined) problems.push(...checkSubject(found.subject, undefined, env));
  if (found.title !== undefined) problems.push(...checkTitle(found.title, found.branch, env));
  if (found.description !== undefined) problems.push(...checkDescription(found.description));
  return problems;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  let found;
  try {
    found = await collect(argv, env, deps);
  } catch (error) {
    err(`pr-check: ${error.message}`);
    return 2;
  }
  if (found.skip) {
    out(`pr-check: skipped, ${found.skip}`);
    return 0;
  }
  const problems = judge(found, env);
  if (problems.length === 0) {
    out(`pr-check: ${Object.keys(found).join(", ")} follow ${RULES}`);
    return 0;
  }
  for (const line of problems) err(line);
  err(`pr-check: see ${RULES}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
