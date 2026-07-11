import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Guideline } from "../domain/guideline.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";
import { assertSafeRef } from "../git/diff.js";

export interface GuidelineFile {
  /** Path shown in problems and sources; repo-relative where possible. */
  displayPath: string;
  content: string;
}

export interface LoadedGuidelines {
  guidelines: Guideline[];
  /** Human-readable notes about files that could not become guidelines. */
  problems: string[];
  /** Guidelines parsed fine but switched off via enabled: false. */
  disabled: number;
}

/** Linear-time frontmatter split; guideline files are untrusted input. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | undefined {
  const lines = raw.split("\n");
  if (String(lines[0]).trimEnd() !== "---") return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (closing === -1) return undefined;
  return {
    frontmatter: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n"),
  };
}

function deriveTitle(meta: Record<string, unknown>, body: string, filePath: string): string {
  if (typeof meta["title"] === "string" && meta["title"].trim() !== "") return meta["title"].trim();
  const heading = body.split("\n").find((line) => line.startsWith("# "));
  if (heading !== undefined && heading.slice(2).trim() !== "") return heading.slice(2).trim();
  return path.basename(filePath, ".md");
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

type ParsedGuideline = { guideline: Guideline } | { problem: string } | { disabled: true };

export function parseGuidelineContent(content: string, displayPath: string): ParsedGuideline {
  const split = splitFrontmatter(content);
  if (split === undefined) return { problem: `${displayPath}: no frontmatter header` };
  const { frontmatter, body } = split;
  let meta: unknown;
  try {
    meta = parseYaml(frontmatter);
  } catch (error) {
    return { problem: `${displayPath}: unreadable frontmatter (${(error as Error).message})` };
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { problem: `${displayPath}: frontmatter must be a mapping` };
  }
  const record = meta as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") {
    return { problem: `${displayPath}: missing required frontmatter field "id"` };
  }
  const severity = record["severity"];
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as Severity)) {
    return { problem: `${displayPath}: severity must be one of ${SEVERITIES.join(", ")}` };
  }
  if (record["enabled"] === false) return { disabled: true };
  if (record["enabled"] !== undefined && typeof record["enabled"] !== "boolean") {
    return { problem: `${displayPath}: "enabled" must be true or false` };
  }
  const languages = stringList(record["languages"]);
  if (languages === undefined) {
    return { problem: `${displayPath}: "languages" must be a list of language names` };
  }
  const paths = stringList(record["paths"]);
  if (paths === undefined) {
    return { problem: `${displayPath}: "paths" must be a list of path globs` };
  }
  const tags = stringList(record["tags"]);
  if (tags === undefined) {
    return { problem: `${displayPath}: "tags" must be a list of strings` };
  }
  return {
    guideline: {
      id: id.trim(),
      severity: severity as Severity,
      title: deriveTitle(record, body, displayPath),
      body: body.trim(),
      sourcePath: displayPath,
      languages,
      paths,
      tags,
    },
  };
}

export function loadGuidelinesFromFiles(files: readonly GuidelineFile[]): LoadedGuidelines {
  const guidelines: Guideline[] = [];
  const problems: string[] = [];
  let disabled = 0;
  const seen = new Map<string, string>();
  for (const file of files) {
    const parsed = parseGuidelineContent(file.content, file.displayPath);
    if ("problem" in parsed) {
      problems.push(parsed.problem);
      continue;
    }
    if ("disabled" in parsed) {
      disabled += 1;
      continue;
    }
    const { guideline } = parsed;
    const previous = seen.get(guideline.id);
    if (previous !== undefined) {
      problems.push(
        `${guideline.sourcePath}: duplicate id "${guideline.id}" (first seen in ${previous})`,
      );
      continue;
    }
    seen.set(guideline.id, guideline.sourcePath);
    guidelines.push(guideline);
  }
  return { guidelines, problems, disabled };
}

function markdownFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

export function readWorkingTreeGuidelines(dir: string): GuidelineFile[] {
  if (!existsSync(dir)) {
    throw new ToolError(
      `guidelines directory not found: ${dir}; check review.guidelinesDir or run init`,
    );
  }
  return markdownFilesUnder(dir).map((filePath) => ({
    displayPath: filePath,
    content: readFileSync(filePath, "utf8"),
  }));
}

/** Guideline files as they exist on a git ref; undefined when the ref holds none. */
export function readGitRefGuidelines(
  cwd: string,
  ref: string,
  dir: string,
): GuidelineFile[] | undefined {
  assertSafeRef(ref);
  const listing = runGit(cwd, ["ls-tree", "-r", "--name-only", ref, "--", dir]);
  const paths = listing.split("\n").filter((line) => line.trim().endsWith(".md"));
  if (paths.length === 0) return undefined;
  return paths.map((filePath) => ({
    displayPath: `${ref}:${filePath}`,
    content: runGit(cwd, ["show", `${ref}:${filePath}`]),
  }));
}

export function loadGuidelines(dir: string): LoadedGuidelines {
  return loadGuidelinesFromFiles(readWorkingTreeGuidelines(dir));
}

export interface ResolvedGuidelines extends LoadedGuidelines {
  origin: string;
  notices: string[];
}

/**
 * The guidelines that judge a review come from the target ref by default
 * (ADR 0002), so a pull request cannot weaken its own rules. The working
 * tree serves the bootstrap case and the explicit source mode.
 */
export function resolveGuidelines(
  cwd: string,
  guidelinesRef: string,
  guidelinesDir: string,
  targetRef: string,
): ResolvedGuidelines {
  const notices: string[] = [];
  if (guidelinesRef !== "source") {
    const ref = guidelinesRef === "target" ? targetRef : guidelinesRef;
    const files = readGitRefGuidelines(cwd, ref, guidelinesDir);
    if (files !== undefined) {
      return { ...loadGuidelinesFromFiles(files), origin: ref, notices };
    }
    notices.push(
      `no guidelines found on ${ref}; using the working tree (expected while bootstrapping)`,
    );
  }
  const files = readWorkingTreeGuidelines(path.resolve(cwd, guidelinesDir));
  return { ...loadGuidelinesFromFiles(files), origin: "working tree", notices };
}
