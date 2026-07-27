import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { markdownFilesUnder } from "./loader.js";
import { PACK_MANIFEST_NAME } from "./packs.js";

export interface PackInitOptions {
  name: string;
  /** Where the pack lands; defaults to packs/<name> under the repo root. */
  out?: string;
  force: boolean;
}

/**
 * Wraps an existing guidelines directory into a shareable pack: a manifest
 * plus a copy of every markdown file, nested structure preserved. The source
 * directory stays untouched.
 */
export function runGuidelinesPackInit(
  deps: RuntimeDeps,
  flags: Readonly<Record<string, string>>,
  options: PackInitOptions,
): number {
  const config = deps.loadConfig(flags);
  const sourceDir = path.resolve(deps.cwd, config.review.guidelinesDir);
  if (!existsSync(sourceDir)) {
    throw new ToolError(`guidelines directory not found: ${sourceDir}`);
  }
  const files = markdownFilesUnder(sourceDir);
  if (files.length === 0) {
    throw new ToolError(`no guideline markdown files under ${sourceDir}; nothing to pack`);
  }

  const outDir = path.resolve(deps.cwd, options.out ?? path.join("packs", options.name));
  if (existsSync(outDir)) {
    if (!options.force) {
      throw new ToolError(`${outDir} already exists; pass --force to overwrite it`);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const manifest = stringifyYaml({
    name: options.name,
    version: "0.1.0",
    description: `Guideline pack created from ${config.review.guidelinesDir}`,
  });
  writeFileSync(path.join(outDir, PACK_MANIFEST_NAME), manifest);
  for (const file of files) {
    const target = path.join(outDir, path.relative(sourceDir, file));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file));
  }

  deps.out(
    `pack ${options.name}: ${String(files.length)} guideline file(s) wrapped into ${path.relative(deps.cwd, outDir)}\n`,
  );
  return 0;
}
