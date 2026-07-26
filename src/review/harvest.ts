import type { Severity } from "../domain/severity.js";
import type { RejectedCandidate } from "./parse.js";

export interface HarvestedDraft {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  rationale: string;
}

interface Group {
  title: string;
  severity?: Severity;
  count: number;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "unwritten-rule" : slug;
}

/**
 * Deterministically turns uncited candidates the model raised repeatedly into
 * promotable guideline drafts. No model call: the recurrence is the signal, and
 * a person refines the draft when promoting it, so this never becomes a silent
 * feedback channel (ROADMAP: the learnings loop stays human-in-the-loop).
 */
export function harvestUncited(
  rejected: readonly RejectedCandidate[],
  minRecurrence = 2,
): HarvestedDraft[] {
  const groups = new Map<string, Group>();
  for (const candidate of rejected) {
    if (candidate.reason !== "uncited" || candidate.title === undefined) continue;
    const key = candidate.title.trim().toLowerCase().replace(/\s+/g, " ");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, {
        title: candidate.title,
        ...(candidate.severity !== undefined ? { severity: candidate.severity } : {}),
        count: 1,
      });
    }
  }
  const drafts: HarvestedDraft[] = [];
  for (const group of groups.values()) {
    if (group.count < minRecurrence) continue;
    drafts.push({
      id: slugify(group.title),
      severity: group.severity ?? "MINOR",
      title: group.title,
      body: `The model raised "${group.title}" ${String(group.count)} times, but no guideline covers it.`,
      rationale: `recurred ${String(group.count)} times in one review with no covering guideline`,
    });
  }
  return drafts;
}
