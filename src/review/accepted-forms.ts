import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Finding } from "../domain/finding.js";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";

/** The file a repository keeps in its guidelines folder. */
export const ACCEPTED_FORMS_FILE = "accepted-forms.json";

const AcceptedFormsSchema = z.strictObject({
  /** Tags never flagged; `*` stands for any one value, as in `@locale:*`. */
  tags: z.array(z.string().regex(/^@\S+$/, "a tag starts with @")).default([]),
  /** Per guideline id, regular expressions a finding's title, body or quote must not match. */
  patterns: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
});

export interface AcceptedForms {
  tags: string[];
  patterns: Record<string, string[]>;
}

/** Validates the file's text; `file` names it in every error. */
export function parseAcceptedForms(text: string, file: string): AcceptedForms {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`${file}: not valid JSON (${(error as Error).message})`);
  }
  const parsed = AcceptedFormsSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
    );
    throw new ToolError(`${file}: ${problems.join("; ")}`);
  }
  for (const [id, sources] of Object.entries(parsed.data.patterns)) {
    for (const source of sources) {
      try {
        new RegExp(source);
      } catch {
        throw new ToolError(
          `${file}: patterns.${id}: "${source}" is not a valid regular expression`,
        );
      }
    }
  }
  return parsed.data;
}

/**
 * Reads the file from where the guidelines came from, so a pull request cannot
 * accept its own forms: the guidelines ref, the working tree, or a local folder.
 */
export function readAcceptedForms(
  cwd: string,
  origin: string,
  guidelinesDir: string,
): AcceptedForms | undefined {
  if (origin === "packs only" || origin === "none") return undefined;
  let text: string | undefined;
  let file: string;
  if (origin === "working tree" || origin.startsWith("local:")) {
    const dir = origin === "working tree" ? path.resolve(cwd, guidelinesDir) : origin.slice(6);
    const full = path.join(dir, ACCEPTED_FORMS_FILE);
    file = path.relative(cwd, full);
    if (existsSync(full)) text = readFileSync(full, "utf8");
  } else {
    file = path.posix.join(guidelinesDir, ACCEPTED_FORMS_FILE);
    try {
      text = runGit(cwd, ["show", `${origin}:${file}`]);
    } catch {
      text = undefined;
    }
  }
  return text === undefined ? undefined : parseAcceptedForms(text, file);
}

const TAG = /@[A-Za-z][\w-]*(?::[\w.-]+)*/g;

function tagMatches(tag: string, entry: string): boolean {
  if (!entry.includes("*")) return tag === entry;
  const source = entry
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\w.-]+");
  return new RegExp(`^${source}$`).test(tag);
}

/** The tags a finding flags: its title's, or its body's when the title names none. */
function flaggedTags(finding: Finding): string[] {
  const title = finding.title.match(TAG) ?? [];
  return title.length > 0 ? title : (finding.body.match(TAG) ?? []);
}

/** Whether the repository listed the form this finding flags. */
export function isAccepted(finding: Finding, forms: AcceptedForms): boolean {
  const tags = flaggedTags(finding);
  if (tags.length > 0 && tags.every((tag) => forms.tags.some((entry) => tagMatches(tag, entry)))) {
    return true;
  }
  if (finding.kind !== "violation") return false;
  const patterns = forms.patterns[finding.guidelineId] ?? [];
  const texts = [finding.title, finding.body, finding.quote ?? ""];
  return patterns.some((source) => texts.some((text) => new RegExp(source).test(text)));
}

/** Findings the run posts, and the ones on an accepted form it only counts. */
export function partitionAccepted(
  findings: readonly Finding[],
  forms: AcceptedForms | undefined,
): { kept: Finding[]; accepted: Finding[] } {
  const kept: Finding[] = [];
  const accepted: Finding[] = [];
  for (const finding of findings) {
    if (forms !== undefined && isAccepted(finding, forms)) accepted.push(finding);
    else kept.push(finding);
  }
  return { kept, accepted };
}
