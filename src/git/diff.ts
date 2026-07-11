import { ToolError } from "../errors.js";
import { runGit } from "./git.js";

/** Conservative ref shape: blocks option injection and git-level flag smuggling. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref)) {
    throw new ToolError(`unsafe git ref name: ${JSON.stringify(ref)}`);
  }
}

/**
 * The three-dot merge-base diff of HEAD against the target: exactly the
 * changes this branch introduces, excluding target-only commits (ADR 0004).
 */
export function mergeBaseDiff(cwd: string, target: string): string {
  assertSafeRef(target);
  return runGit(cwd, ["diff", "--no-color", `${target}...HEAD`, "--"]);
}
