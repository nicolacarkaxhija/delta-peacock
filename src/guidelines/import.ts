import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { RuntimeDeps } from "../deps.js";
import { ToolError } from "../errors.js";
import { markdownFilesUnder, splitFrontmatter } from "./loader.js";

export interface ImportOptions {
  from: string;
  /** Where converted files land; defaults to converting in place. */
  out?: string;
}

interface Conversion {
  content: string;
  changed: boolean;
}

/**
 * Converts one legacy guideline to this project's format: the singular
 * `language` field becomes a `languages` list, and the legacy `name` field is
 * dropped, becoming the H1 title when the body has none. Everything else in
 * the frontmatter and body is preserved as written, so a second run is a
 * no-op. Undefined means the file is not convertible and stays as it is.
 */
export function convertLegacyGuideline(content: string): Conversion | undefined {
  const split = splitFrontmatter(content);
  if (split === undefined) return undefined;
  const doc = parseDocument(split.frontmatter);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;

  let changed = false;
  let body = split.body;
  const language = doc.get("language");
  if (typeof language === "string") {
    doc.delete("language");
    if (!doc.has("languages")) doc.set("languages", [language]);
    changed = true;
  }
  const name = doc.get("name");
  if (typeof name === "string") {
    doc.delete("name");
    if (!body.split("\n").some((line) => line.startsWith("# "))) {
      body = `# ${name}\n\n${body.replace(/^\n+/, "")}`;
    }
    changed = true;
  }
  if (!changed) return { content, changed: false };
  return { content: `---\n${doc.toString()}---\n${body}`, changed: true };
}

/** Converts a legacy guideline corpus so existing rule sets migrate in one step. */
export function runGuidelinesImport(deps: RuntimeDeps, options: ImportOptions): number {
  const fromDir = path.resolve(deps.cwd, options.from);
  if (!existsSync(fromDir)) {
    throw new ToolError(`import source not found: ${fromDir}`);
  }
  const outDir = path.resolve(deps.cwd, options.out ?? options.from);
  const files = markdownFilesUnder(fromDir);
  if (files.length === 0) {
    throw new ToolError(`no markdown files under ${fromDir}; nothing to import`);
  }

  let converted = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const file of files) {
    const rel = path.relative(fromDir, file);
    const target = path.join(outDir, rel);
    const raw = readFileSync(file, "utf8");
    const conversion = convertLegacyGuideline(raw);
    if (conversion === undefined) {
      skipped += 1;
      deps.err(`skipped ${rel}: no readable frontmatter\n`);
    } else if (conversion.changed) {
      converted += 1;
    } else {
      unchanged += 1;
    }
    // an in-place run only touches files that actually changed
    if (target === file && conversion?.changed !== true) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, conversion?.changed === true ? conversion.content : raw);
  }

  deps.out(
    `import: ${String(converted)} converted, ${String(unchanged)} already current, ${String(skipped)} skipped\n`,
  );
  return 0;
}
