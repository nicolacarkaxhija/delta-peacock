import path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { RuntimeDeps } from "../deps.js";
import { isKnownLanguage } from "./languages.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "./loader.js";

/**
 * Validates the guideline corpus in the working tree: the authoring loop's
 * fast feedback, and the natural pre-commit hook for guideline repos.
 */
export function runGuidelinesLint(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
): number {
  const config = loadConfig({ root: deps.cwd, env: deps.env, flags });
  const dir = path.resolve(deps.cwd, config.review.guidelinesDir);
  const loaded = loadGuidelinesFromFiles(readWorkingTreeGuidelines(dir));

  const problems = [...loaded.problems];
  for (const guideline of loaded.guidelines) {
    if (guideline.body === "") {
      problems.push(
        `${guideline.sourcePath}: empty body; a guideline needs its expectations spelled out`,
      );
    }
    for (const language of guideline.languages) {
      if (!isKnownLanguage(language)) {
        problems.push(`${guideline.sourcePath}: unknown language "${language}"`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) deps.err(`${problem}\n`);
    deps.err(`guidelines lint failed with ${String(problems.length)} problem(s)\n`);
    return 1;
  }
  deps.out(
    `guidelines ok: ${String(loaded.guidelines.length)} usable, ${String(loaded.disabled)} disabled\n`,
  );
  return 0;
}
