import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { findCandidates, type Candidate } from "../src/review/checks/detect.js";
import { runChecks } from "../src/review/checks/index.js";
import { settle } from "../src/review/checks/judge.js";
import { numberCandidates } from "../src/review/checks/numbers.js";

const RULE =
  "Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.";

const NUMBERS: Guideline = {
  id: "no-magic-numbers",
  severity: "MAJOR",
  title: "No magic numbers",
  body: RULE,
  sourcePath: "guidelines/no-magic-numbers.md",
  languages: ["typescript", "javascript", "shell"],
  paths: ["src/**", "scripts/**"],
  tags: [],
};

const COMMENTS: Guideline = {
  id: "natural-comments",
  severity: "MINOR",
  title: "Natural comments",
  body: "It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.",
  sourcePath: "guidelines/natural-comments.md",
  languages: ["typescript"],
  paths: ["src/**"],
  tags: [],
};

const all = (text: string): Set<number> => new Set(text.split("\n").map((_, index) => index + 1));
const candidates = (text: string, file = "src/a.ts"): Candidate[] =>
  numberCandidates(NUMBERS, file, text, all(text));

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the check found no candidate");
  return value;
}

/** What a candidate becomes with no model: a finding or left to a person. */
async function withoutModel(candidate: Candidate, guideline = NUMBERS): Promise<string> {
  const outcome = await settle(undefined, candidate, guideline, "");
  return outcome.outcome;
}

describe("the judged shapes without a model", () => {
  it("a candidate with a judge question is left to a person", async () => {
    const found = candidates(
      "const PAGE_ROWS = 25;\nawait page.goto(url, { timeout: 5000 });\nconst price = total * 19;\n",
    );
    expect(found).toHaveLength(3);
    for (const one of found) expect(await withoutModel(one)).toBe("left");
  });

  it("a comment that may narrate is left to a person with its question", async () => {
    const text = "// we fixed this after the chat\nexport const a = 1;\n";
    const [narration] = findCandidates([{ guideline: COMMENTS, check: "comments" }], {
      changed: new Map([["src/a.ts", all(text)]]),
      read: () => text,
      files: () => [],
      testIdAttribute: "data-testid",
    });
    expect(narration?.shape).toBe("narration");
    const outcome = await settle(undefined, present(narration), COMMENTS, "");
    expect(outcome.outcome).toBe("left");
    expect(outcome.left).toEqual({
      file: "src/a.ts",
      line: 1,
      guidelineId: "natural-comments",
      shape: "narration",
      question: present(narration).judge?.question,
    });
    expect(outcome.notice).toContain("left to a person: needs a judgement");
  });

  it("a candidate the check measured is a finding with no model", async () => {
    const text = "// first line\n// second line\nexport const a = 1;\n";
    const [multi] = findCandidates([{ guideline: COMMENTS, check: "comments" }], {
      changed: new Map([["src/a.ts", all(text)]]),
      read: () => text,
      files: () => [],
      testIdAttribute: "data-testid",
    });
    expect(multi?.judge).toBeUndefined();
    expect(await withoutModel(present(multi), COMMENTS)).toBe("finding");
  });

  it("runs every check with no port and counts what it left", async () => {
    const text = "const RETRY_LIMIT = 3;\nconst PAGE_ROWS = 25;\n";
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- /dev/null",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,2 @@",
      "+const RETRY_LIMIT = 3;",
      "+const PAGE_ROWS = 25;",
      "",
    ].join("\n");
    const outcome = await runChecks({
      bound: [{ guideline: NUMBERS, check: "numbers" }],
      diff,
      read: () => text,
      files: () => [],
      configFiles: [],
      redact: (value) => value,
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.left.map((one) => one.line)).toEqual([1, 2]);
    expect(outcome.tally).toEqual({
      candidates: 2,
      findings: 0,
      dropped: 0,
      judgeFailed: 0,
      left: 2,
    });
    expect(outcome.usage).toBeUndefined();
  });
});
