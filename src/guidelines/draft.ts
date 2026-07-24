import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Severity } from "../domain/severity.js";

/** A proposed guideline, one step short of being adopted into the corpus. */
export interface Draft {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  rationale: string;
  languages?: string[];
}

/** The draft file is a valid guideline the loader accepts unchanged. */
export function renderDraft(draft: Draft): string {
  return [
    "---",
    `id: ${draft.id}`,
    `severity: ${draft.severity}`,
    ...(draft.languages !== undefined && draft.languages.length > 0
      ? [`languages: [${draft.languages.join(", ")}]`]
      : []),
    "---",
    `# ${draft.title}`,
    "",
    draft.body,
    "",
    "## Rationale",
    "",
    draft.rationale,
    "",
  ].join("\n");
}

/** Writes each draft to `<dir>/<id>.md`; a re-run overwrites, never duplicates. */
export function writeDrafts(cwd: string, dir: string, drafts: readonly Draft[]): string[] {
  if (drafts.length === 0) return [];
  const full = path.resolve(cwd, dir);
  mkdirSync(full, { recursive: true });
  return drafts.map((draft) => {
    writeFileSync(path.join(full, `${draft.id}.md`), renderDraft(draft));
    return `${draft.id}.md`;
  });
}
