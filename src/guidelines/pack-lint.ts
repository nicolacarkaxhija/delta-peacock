import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { runLintScaffold } from "./lint-scaffold.js";
import { loadGuidelinesFromFiles, markdownFilesUnder } from "./loader.js";
import { PACK_MANIFEST_NAME } from "./packs.js";

export interface PackLintOptions {
  dir: string;
}

/** Manifest fields worth having, checked without failing the whole pack. */
function manifestProblems(dir: string): { problems: string[]; warnings: string[]; name?: string } {
  const manifestPath = path.join(dir, PACK_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return { problems: [`${PACK_MANIFEST_NAME} not found in ${dir}`], warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      problems: [`${PACK_MANIFEST_NAME}: not valid YAML (${(error as Error).message})`],
      warnings: [],
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      problems: [`${PACK_MANIFEST_NAME}: must be a mapping with at least a name`],
      warnings: [],
    };
  }
  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (typeof record["name"] !== "string" || record["name"].trim() === "") {
    problems.push(`${PACK_MANIFEST_NAME}: a pack needs a non-empty name`);
  }
  if (typeof record["version"] !== "string") {
    warnings.push(`${PACK_MANIFEST_NAME}: no version; pin consumers cannot tell releases apart`);
  }
  if (typeof record["description"] !== "string") {
    warnings.push(`${PACK_MANIFEST_NAME}: no description; the registry has nothing to show`);
  }
  return {
    problems,
    warnings,
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
  };
}

/** Validates a pack you are authoring: its manifest and every guideline in it. */
export function runGuidelinesPackLint(deps: RuntimeDeps, options: PackLintOptions): number {
  const dir = path.resolve(deps.cwd, options.dir);
  if (!existsSync(dir)) {
    throw new ToolError(`pack directory not found: ${options.dir}`);
  }

  const manifest = manifestProblems(dir);
  for (const warning of manifest.warnings) deps.err(`warning: ${warning}\n`);

  const files = markdownFilesUnder(dir).map((filePath) => ({
    displayPath: path.relative(dir, filePath).replaceAll("\\", "/"),
    content: readFileSync(filePath, "utf8"),
  }));
  const loaded = loadGuidelinesFromFiles(files);
  const problems = [...manifest.problems, ...loaded.problems];
  if (loaded.guidelines.length === 0 && loaded.problems.length === 0) {
    problems.push("the pack holds no usable guidelines");
  }

  return runLintScaffold(deps, {
    problems,
    guidelines: loaded.guidelines,
    label: "pack lint",
    successMessage: `pack ok: ${manifest.name ?? "(unnamed)"} — ${String(loaded.guidelines.length)} usable guideline(s)\n`,
  });
}
