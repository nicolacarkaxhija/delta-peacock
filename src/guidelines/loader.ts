import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Guideline } from "../domain/guideline.js";
import { SEVERITIES, type Severity } from "../domain/severity.js";

export interface LoadedGuidelines {
  guidelines: Guideline[];
  /** Human-readable notes about files that could not become guidelines. */
  problems: string[];
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

function markdownFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function deriveTitle(meta: Record<string, unknown>, body: string, filePath: string): string {
  if (typeof meta["title"] === "string" && meta["title"].trim() !== "") return meta["title"].trim();
  const heading = body.split("\n").find((line) => line.startsWith("# "));
  if (heading !== undefined && heading.slice(2).trim() !== "") return heading.slice(2).trim();
  return path.basename(filePath, ".md");
}

function parseGuidelineFile(filePath: string): { guideline: Guideline } | { problem: string } {
  const raw = readFileSync(filePath, "utf8");
  const split = splitFrontmatter(raw);
  if (split === undefined) return { problem: `${filePath}: no frontmatter header` };
  const { frontmatter, body } = split;
  let meta: unknown;
  try {
    meta = parseYaml(frontmatter);
  } catch (error) {
    return { problem: `${filePath}: unreadable frontmatter (${(error as Error).message})` };
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { problem: `${filePath}: frontmatter must be a mapping` };
  }
  const record = meta as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") {
    return { problem: `${filePath}: missing required frontmatter field "id"` };
  }
  const severity = record["severity"];
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as Severity)) {
    return {
      problem: `${filePath}: severity must be one of ${SEVERITIES.join(", ")}`,
    };
  }
  return {
    guideline: {
      id: id.trim(),
      severity: severity as Severity,
      title: deriveTitle(record, body, filePath),
      body: body.trim(),
      sourcePath: filePath,
    },
  };
}

export function loadGuidelines(dir: string): LoadedGuidelines {
  if (!existsSync(dir)) {
    return { guidelines: [], problems: [`guidelines directory not found: ${dir}`] };
  }
  const guidelines: Guideline[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const filePath of markdownFilesUnder(dir)) {
    const parsed = parseGuidelineFile(filePath);
    if ("problem" in parsed) {
      problems.push(parsed.problem);
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
  return { guidelines, problems };
}
