import path from "node:path";
import type { RuntimeDeps } from "../deps.js";
import { runLintScaffold } from "./lint-scaffold.js";
import { loadGuidelinesFromFiles, readWorkingTreeGuidelines } from "./loader.js";

/**
 * Validates the guideline corpus in the working tree: the authoring loop's
 * fast feedback, and the natural pre-commit hook for guideline repos.
 */
export function runGuidelinesLint(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
): number {
  const config = deps.loadConfig(flags);
  const dir = path.resolve(deps.cwd, config.review.guidelinesDir);
  const loaded = loadGuidelinesFromFiles(
    readWorkingTreeGuidelines(dir),
    config.review.frontmatterContract,
  );

  for (const notice of loaded.notices) deps.err(`${notice}\n`);
  return runLintScaffold(deps, {
    problems: loaded.problems,
    guidelines: loaded.guidelines,
    label: "guidelines lint",
    successMessage: `guidelines ok: ${String(loaded.guidelines.length)} usable, ${String(loaded.disabled)} disabled\n`,
  });
}
