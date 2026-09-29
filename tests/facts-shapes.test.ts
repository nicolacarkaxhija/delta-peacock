import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { findCandidates, type Candidate } from "../src/review/checks/detect.js";
import { runChecks } from "../src/review/checks/index.js";
import { settle } from "../src/review/checks/judge.js";
import {
  namedPurpose,
  numberCandidates,
  numberLiterals,
  shellNumberLiterals,
  statedPurpose,
} from "../src/review/checks/numbers.js";

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

/** The findings the numbers check decides with no model over a source text. */
async function decided(text: string, file = "src/a.ts"): Promise<string[]> {
  const out: string[] = [];
  for (const one of candidates(text, file)) {
    if ((await withoutModel(one)) === "finding") out.push(`${String(one.line)}: ${one.quote}`);
  }
  return out;
}

describe("what a name or the code says a number is for", () => {
  it("reads it from a word of the name", () => {
    expect(namedPurpose("RETRY_LIMIT")).toBe("retry count");
    expect(namedPurpose("maxBuffer")).toBe("limit");
    expect(namedPurpose("timeoutMs")).toBe("timeout");
    expect(namedPurpose("#pollInterval")).toBe("delay");
    expect(namedPurpose("PAGE_ROWS")).toBeUndefined();
    expect(namedPurpose("HTTP_OK")).toBeUndefined();
  });

  it("reads it from a key, a default, a comparison, a delay or a named call", () => {
    const purpose = (line: string, at = 0): string | undefined =>
      statedPurpose(line, numberLiterals(line)[at] ?? { line: 1, column: 0, text: "" });
    expect(purpose("await page.goto(url, { timeout: 5000 });")).toBe("timeout");
    expect(purpose("const attempts = options.attempts ?? 3;")).toBe("retry count");
    expect(purpose("signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),")).toBe("timeout");
    expect(purpose("signal: AbortSignal.timeout(7500),")).toBe("timeout");
    expect(purpose("for (let attempt = 0; attempt < 2; attempt += 1) {", 1)).toBe("retry count");
    expect(purpose("setTimeout(done, 250);")).toBe("delay");
    expect(purpose("const overhead = tokens(fence) + 12;")).toBeUndefined();
    expect(purpose("const wanted = 250 * 2 ** attempt;")).toBeUndefined();
    expect(purpose("if (response.status === 404) return;")).toBeUndefined();
  });

  it("reads it in shell", () => {
    const text = "sleep 5\nmax=${MAX_AGE:-30}\ndays=${1:-14}";
    const found = shellNumberLiterals(text);
    const purposes = found.map((one) => statedPurpose(text.split("\n")[one.line - 1] ?? "", one));
    expect(purposes).toEqual(["delay", "limit", undefined]);
  });
});

describe("ordinary code is left to a person", () => {
  it.each([
    ["a five digit pattern", "const ZIP = /^\\d{5}$/;"],
    ["a commit hash pattern", "const HASH = /^[0-9a-f]{40}$/;"],
    ["a short hash", "const short = sha.slice(0, 12);"],
    ["a comment prefix test", "const isComment = line.slice(0, 2) === '//';"],
    ["a date pattern", "const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;"],
    ["a substring", "const head = text.substring(0, 8);"],
    ["a clamp", "return Math.min(wanted, 5000);"],
    ["a schema bound", "name: z.string().max(40),"],
    ["a quantifier inside a named call", "const found = retry(/^x{3}$/);"],
    ["a default on a key that names nothing", "windowTokens: z.number().default(100_000),"],
    ["an exact count", "if (segments.length === 3) route();"],
    ["a pair", "if (group.length < 2) continue;"],
  ])("%s: %s", async (_, line) => {
    expect(await decided(`${line}\n`)).toEqual([]);
    for (const one of candidates(`${line}\n`)) expect(one.judge?.decided).toBeUndefined();
  });

  it("raises no finding on the ordinary code of this repository's own source", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files = ["src", "scripts"].flatMap((dir) =>
      readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(?:ts|mjs|js|sh)$/.test(file))
        .map((file) => path.join(dir, file)),
    );
    const found = (
      await Promise.all(
        files.map(async (file) =>
          (await decided(readFileSync(path.join(root, file), "utf8"), file)).map(
            (line) => `${file}:${line}`,
          ),
        ),
      )
    ).flat();
    expect(found.length).toBeGreaterThan(0);
    // a clamp with a plain bound such as .min(0) beside a named default is no clamp finding
    const ordinary = /\{\d+(?:,\d*)?\}|\.(?:slice|substring|substr)\(|\b(?:min|max)\((?![01]\))/;
    expect(found.filter((line) => ordinary.test(line))).toEqual([]);
    expect(found.filter((line) => /EXIT_CODE|status(?:Code)?\s*[!=]==?\s*\d/.test(line))).toEqual(
      [],
    );
    // what is left is a name, a key or a length that says what the number is for
    const says =
      /timeout|ttl|delay|interval|backoff|retry|retries|attempt|limit|max|min|cap|ceiling|threshold|sleep|\.(?:length|size)\s*[<>=!]/i;
    expect(found.filter((line) => !says.test(line.slice(line.indexOf(": ") + 2)))).toEqual([]);
  });
});

describe("what is no timeout, delay, retry count or limit", () => {
  it("an exit code constant is no candidate, though its name says timeout", () => {
    expect(candidates("const CELL_TIMEOUT_EXIT_CODE = 124;\n")).toEqual([]);
    expect(candidates("const RATE_LIMIT_STATUS_CODE = 429;\n")).toEqual([]);
  });

  it("a status code beside a retry count is not listed", () => {
    const [found] = candidates(
      "for (let attempt = 0; attempt < 3 && res.status === 429; attempt += 1) {\n",
    );
    expect(found?.title).toBe("Inline number 3");
    expect(found?.judge?.decided).toBe("`3` is written inline where the code sets a retry count");
  });

  it.each([
    ["a fixture", "src/__fixtures__/suite/playwright.config.ts"],
    ["a test file", "src/run.test.ts"],
  ])("a number in %s is left to a person", async (_, file) => {
    expect(await decided("export default { timeout: 5000 };\n", file)).toEqual([]);
  });
});

describe("what the guideline names that the code states plainly", () => {
  it.each([
    [
      "a sleep call",
      "await sleep(500 * 2 ** attempt);",
      "`500` is written inline where the code sets a delay",
    ],
    [
      "a length comparison",
      "if (items.length > 37) paginate();",
      "`37` is written inline where the code sets a threshold",
    ],
    [
      "a size comparison",
      "if (seen.size >= 200) flush();",
      "`200` is written inline where the code sets a threshold",
    ],
    [
      "a default on a key that names a limit",
      "maxTokens: z.number().int().positive().default(4000),",
      "`4000` is written inline where the code sets a limit",
    ],
  ])("%s is a finding", async (_, line, reason) => {
    const [found] = candidates(`${line}\n`);
    expect(found?.judge?.decided).toBe(reason);
    expect(await withoutModel(present(found))).toBe("finding");
  });
});

describe("the judged shapes without a model", () => {
  it("a named constant with no comment and a purpose in its name is a finding", async () => {
    const [found] = candidates("const RETRY_LIMIT = 3;\n");
    expect(found?.judge?.decided).toBe(
      "`RETRY_LIMIT` names a retry count and has no comment next to it",
    );
    expect(await withoutModel(present(found))).toBe("finding");
  });

  it("a named constant with a comment, or a name that says nothing, is left to a person", async () => {
    const commented = candidates("// the rows on one page\nconst PAGE_ROWS = 25;\n");
    const unnamed = candidates("const PAGE_ROWS = 25;\n");
    const counted = candidates("// how many tries\nconst MAX_TRIES = 4;\n");
    for (const found of [...commented, ...unnamed, ...counted]) {
      expect(found.judge?.decided).toBeUndefined();
      expect(await withoutModel(found)).toBe("left");
    }
  });

  it("an inline number the code names is a finding, any other is left to a person", async () => {
    const [timeout, plain] = candidates(
      "await page.goto(url, { timeout: 5000 });\nconst price = total * 19;\n",
    );
    expect(timeout?.judge?.decided).toBe("`5000` is written inline where the code sets a timeout");
    expect(await withoutModel(present(timeout))).toBe("finding");
    expect(await withoutModel(present(plain))).toBe("left");
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
    expect(outcome.findings.map((one) => one.line)).toEqual([1]);
    expect(outcome.left.map((one) => one.line)).toEqual([2]);
    expect(outcome.tally).toEqual({
      candidates: 2,
      findings: 1,
      dropped: 0,
      judgeFailed: 0,
      left: 1,
    });
    expect(outcome.usage).toBeUndefined();
  });
});
