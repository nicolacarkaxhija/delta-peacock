import { spawnSync } from "node:child_process";
import { ToolError } from "../errors.js";

export function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.error) {
    throw new ToolError(`git could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new ToolError(`git ${args[0] ?? ""} failed: ${detail}`);
  }
  return result.stdout;
}
