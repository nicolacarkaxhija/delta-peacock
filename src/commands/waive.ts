import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";

export interface WaiveOptions {
  guidelineId: string;
  file: string;
  line: number;
  reason: string;
  until?: string;
}

/**
 * Inserts an in-code waiver directive as a trailing comment on the target line,
 * a deliberate sibling of `fix`: the reviewer never writes waivers itself, a
 * person does, and this only saves the typing.
 */
export function runWaive(deps: RuntimeDeps, options: WaiveOptions): number {
  const reason = options.reason.trim();
  if (reason === "") throw new ToolError("a waiver needs a reason");
  const full = path.resolve(deps.cwd, options.file);
  if (!existsSync(full)) throw new ToolError(`file not found: ${options.file}`);
  const lines = readFileSync(full, "utf8").split("\n");
  const target = lines[options.line - 1];
  if (target === undefined) {
    throw new ToolError(`${options.file} has no line ${String(options.line)}`);
  }
  const until = options.until !== undefined ? ` until=${options.until}` : "";
  const leader = /\.(py|rb|sh|bash|ya?ml|toml)$/.test(options.file) ? "#" : "//";
  lines[options.line - 1] =
    `${target} ${leader} delta-peacock:allow ${options.guidelineId} — ${reason}${until}`;
  writeFileSync(full, lines.join("\n"));
  deps.out(`waived ${options.guidelineId} at ${options.file}:${String(options.line)}\n`);
  return 0;
}
