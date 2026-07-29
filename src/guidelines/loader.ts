import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Guideline } from "../domain/guideline.js";
import { STRUCTURAL_CHECKS, type StructuralCheck } from "../domain/guideline.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";
import { assertSafeRef } from "../git/diff.js";
import { resolvePack } from "./packs.js";

export interface GuidelineFile {
  /** Path shown in problems and sources; repo-relative where possible. */
  displayPath: string;
  content: string;
}

/**
 * How a guideline missing `languages` or `paths` in its frontmatter is
 * treated. `lenient` (the default) is the historical behavior: the field
 * defaults to `[]` (applies everywhere) and a notice names the rule and the
 * gap, so an author sees it instead of it defaulting silently. `strict` is
 * the old Python reviewer's contract: such a rule is skipped entirely, with
 * a warning, rather than risk misfiring on files its author never scoped it
 * to. Either way, the singular `language` key (that same old reviewer's
 * field name) satisfies the scoping requirement exactly like `languages`
 * does; only a guideline supplying neither counts as missing it.
 */
export type FrontmatterContract = "lenient" | "strict";

export interface LoadedGuidelines {
  guidelines: Guideline[];
  /** Human-readable notes about files that could not become guidelines. */
  problems: string[];
  /** Guidelines parsed fine but switched off via enabled: false. */
  disabled: number;
  /** Lenient-mode notices: a guideline kept despite a missing scoping field. */
  notices: string[];
}

/** Linear-time frontmatter split; guideline files are untrusted input. */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } | undefined {
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

/**
 * The singular `language` alias may be written as one bare name or as a
 * list, unlike `languages`, which is always a list. A single string is the
 * one shape `stringList` does not already accept, so it is normalized here
 * before falling back to the same list validation.
 */
function stringOrStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  return stringList(value);
}

type ParsedGuideline =
  { guideline: Guideline; notices?: string[] } | { problem: string } | { disabled: true };

export function parseGuidelineContent(
  content: string,
  displayPath: string,
  contract: FrontmatterContract = "lenient",
): ParsedGuideline {
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
  const trimmedId = id.trim();
  const notices: string[] = [];
  // `language` (singular) is an earlier reviewer's frontmatter field, kept
  // as an alias so a migrated corpus works unchanged; `languages` wins when
  // a file somehow carries both, and either one satisfies the scoping
  // requirement below -- only a file with neither is missing it.
  const languagesRaw = record["languages"];
  const languageRaw = record["language"];
  if (languagesRaw !== undefined && languageRaw !== undefined) {
    notices.push(
      `${displayPath}: guideline "${trimmedId}" specifies both "language" and "languages"; ` +
        `using "languages"`,
    );
  }
  const languages =
    languagesRaw !== undefined ? stringList(languagesRaw) : stringOrStringList(languageRaw);
  if (languages === undefined) {
    return {
      problem:
        languagesRaw !== undefined
          ? `${displayPath}: "languages" must be a list of language names`
          : `${displayPath}: "language" must be a string or a list of language names`,
    };
  }
  const pathsRaw = record["paths"];
  const paths = stringList(pathsRaw);
  if (paths === undefined) {
    return { problem: `${displayPath}: "paths" must be a list of path globs` };
  }
  const tags = stringList(record["tags"]);
  if (tags === undefined) {
    return { problem: `${displayPath}: "tags" must be a list of strings` };
  }
  const structuralRaw = record["structural"];
  if (
    structuralRaw !== undefined &&
    (typeof structuralRaw !== "string" ||
      !STRUCTURAL_CHECKS.includes(structuralRaw as StructuralCheck))
  ) {
    return {
      problem: `${displayPath}: "structural" must be one of ${STRUCTURAL_CHECKS.join(", ")}`,
    };
  }
  const structural = structuralRaw as StructuralCheck | undefined;
  // only a field absent under both its names counts as a contract gap; an
  // explicit [] (under either name) is a deliberate "matches everything"
  // choice the author already made
  const missingFields = [
    ...(languagesRaw === undefined && languageRaw === undefined ? ["languages"] : []),
    ...(pathsRaw === undefined ? ["paths"] : []),
  ];
  if (missingFields.length > 0 && contract === "strict") {
    return {
      problem:
        `${displayPath}: guideline "${trimmedId}" is missing required frontmatter field(s) ` +
        `${missingFields.join(", ")}; skipping the rule (strict frontmatter contract)`,
    };
  }
  const guideline: Guideline = {
    id: trimmedId,
    severity: severity as Severity,
    title: deriveTitle(record, body, displayPath),
    body: body.trim(),
    sourcePath: displayPath,
    languages,
    paths,
    tags,
    ...(structural !== undefined ? { structural } : {}),
  };
  if (missingFields.length > 0) {
    notices.push(
      `${displayPath}: guideline "${trimmedId}" is missing frontmatter field(s) ` +
        `${missingFields.join(", ")}; applying it to every changed file (lenient frontmatter contract)`,
    );
  }
  return notices.length === 0 ? { guideline } : { guideline, notices };
}

export function loadGuidelinesFromFiles(
  files: readonly GuidelineFile[],
  contract: FrontmatterContract = "lenient",
): LoadedGuidelines {
  const guidelines: Guideline[] = [];
  const problems: string[] = [];
  const notices: string[] = [];
  let disabled = 0;
  const seen = new Map<string, string>();
  for (const file of files) {
    const parsed = parseGuidelineContent(file.content, file.displayPath, contract);
    if ("problem" in parsed) {
      problems.push(parsed.problem);
      continue;
    }
    if ("disabled" in parsed) {
      disabled += 1;
      continue;
    }
    const { guideline, notices: guidelineNotices } = parsed;
    if (guidelineNotices !== undefined) notices.push(...guidelineNotices);
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
  return { guidelines, problems, disabled, notices };
}

export function markdownFilesUnder(dir: string): string[] {
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
  // -z gives raw NUL-separated paths, so quoted non-ASCII names cannot slip through
  const listing = runGit(cwd, ["ls-tree", "-r", "--name-only", "-z", ref, "--", dir]);
  const paths = listing.split("\0").filter((line) => line.endsWith(".md"));
  if (paths.length === 0) return undefined;
  return paths.map((filePath) => ({
    displayPath: `${ref}:${filePath}`,
    content: runGit(cwd, ["show", `${ref}:${filePath}`]),
  }));
}

export function loadGuidelines(
  dir: string,
  contract: FrontmatterContract = "lenient",
): LoadedGuidelines {
  return loadGuidelinesFromFiles(readWorkingTreeGuidelines(dir), contract);
}

export interface ResolvedGuidelines extends LoadedGuidelines {
  origin: string;
  notices: string[];
}

/**
 * The guidelines that judge a review come from the target ref by default
 * (ADR 0002), so a pull request cannot weaken its own rules. The working
 * tree serves the bootstrap case and the explicit source mode. The `local`
 * ref reads a filesystem directory (absolute or relative to cwd) directly,
 * bypassing git — a troubleshooting aid for trying a guideline set locally.
 */
function resolveLocalGuidelines(
  cwd: string,
  guidelinesRef: string,
  guidelinesDir: string,
  targetRef: string,
  contract: FrontmatterContract,
): ResolvedGuidelines {
  const notices: string[] = [];
  if (guidelinesRef === "local") {
    const dir = path.resolve(cwd, guidelinesDir);
    const loaded = loadGuidelinesFromFiles(readWorkingTreeGuidelines(dir), contract);
    return { ...loaded, origin: `local:${dir}`, notices: [...loaded.notices, ...notices] };
  }
  if (guidelinesRef !== "source") {
    const ref = guidelinesRef === "target" ? targetRef : guidelinesRef;
    let files: GuidelineFile[] | undefined;
    try {
      files = readGitRefGuidelines(cwd, ref, guidelinesDir);
    } catch (error) {
      // a shallow or partial clone may not hold the target ref at all; only
      // the default mode may degrade, a pin must stay tamper-resistant
      if (guidelinesRef !== "target") throw error;
      notices.push(
        `could not read guidelines from ${ref} (${String((error as Error).message.split("\n")[0])}); using the working tree`,
      );
    }
    if (files !== undefined) {
      const loaded = loadGuidelinesFromFiles(files, contract);
      return { ...loaded, origin: ref, notices: [...loaded.notices, ...notices] };
    }
    if (guidelinesRef !== "target") {
      // an explicitly pinned ref must not silently fall back to PR-controlled content
      throw new ToolError(
        `no guidelines found on the pinned ref ${ref}; refusing to fall back to the working tree`,
      );
    }
    if (notices.length === 0) {
      notices.push(
        `no guidelines found on ${ref}; using the working tree (expected while bootstrapping)`,
      );
    }
  }
  const files = readWorkingTreeGuidelines(path.resolve(cwd, guidelinesDir));
  const loaded = loadGuidelinesFromFiles(files, contract);
  return { ...loaded, origin: "working tree", notices: [...loaded.notices, ...notices] };
}

/**
 * Local guidelines resolve as before; configured packs load underneath them.
 * Precedence is deliberate: packs merge in listed order with later packs
 * winning id collisions, and the local corpus always wins last. Every
 * override emits a notice naming the guideline and the pack that lost, so a
 * pack can never displace a rule silently.
 */
export function resolveGuidelines(
  cwd: string,
  guidelinesRef: string,
  guidelinesDir: string,
  targetRef: string,
  packs: readonly string[] = [],
  contract: FrontmatterContract = "lenient",
): ResolvedGuidelines {
  if (packs.length === 0) {
    return resolveLocalGuidelines(cwd, guidelinesRef, guidelinesDir, targetRef, contract);
  }
  let local: ResolvedGuidelines;
  try {
    local = resolveLocalGuidelines(cwd, guidelinesRef, guidelinesDir, targetRef, contract);
  } catch (error) {
    // a packs-only setup has no local corpus at all; every other failure
    // (unreachable ref, empty pin) keeps its tamper-resistant loudness
    if (
      !(error instanceof ToolError) ||
      !error.message.includes("guidelines directory not found")
    ) {
      throw error;
    }
    local = {
      guidelines: [],
      problems: [],
      disabled: 0,
      origin: "packs only",
      notices: [`${error.message}; reviewing with pack guidelines only`],
    };
  }

  const notices = [...local.notices];
  const problems: string[] = [];
  let disabled = 0;
  const fromPacks = new Map<string, Guideline & { pack: string }>();
  for (const spec of packs) {
    const pack = resolvePack(cwd, spec);
    const loaded = loadGuidelinesFromFiles(pack.files, contract);
    problems.push(...loaded.problems);
    disabled += loaded.disabled;
    notices.push(...loaded.notices);
    for (const guideline of loaded.guidelines) {
      const previous = fromPacks.get(guideline.id);
      if (previous !== undefined) {
        notices.push(
          `guideline "${guideline.id}" from pack ${previous.pack} is overridden by pack ${pack.manifest.name}`,
        );
      }
      fromPacks.set(guideline.id, { ...guideline, pack: pack.manifest.name });
    }
  }

  const localIds = new Set(local.guidelines.map((guideline) => guideline.id));
  const guidelines: Guideline[] = [];
  for (const [id, guideline] of fromPacks) {
    if (localIds.has(id)) {
      notices.push(
        `guideline "${id}" from pack ${guideline.pack} is overridden by the local corpus`,
      );
      continue;
    }
    guidelines.push(guideline);
  }
  guidelines.push(...local.guidelines);

  return {
    guidelines,
    problems: [...problems, ...local.problems],
    disabled: disabled + local.disabled,
    origin: local.origin,
    notices,
  };
}
