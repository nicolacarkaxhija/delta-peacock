import { describe, expect, it } from "vitest";
import type { Violation } from "../src/domain/finding.js";
import type { Guideline, GuidelineCheck } from "../src/domain/guideline.js";
import type { ModelPort } from "../src/model/port.js";
import {
  CHECK_SENTENCES,
  checkSentenceProblems,
  runChecks,
  sentenceOf,
} from "../src/review/checks/index.js";
import { quotesGuideline } from "../src/review/parse.js";
import { guidelineLine, renderCommentBody } from "../src/scm/comment-format.js";
import { buildInsightReport } from "../src/scm/publish.js";
import { ledgerRecords } from "../src/stats/record.js";

function guideline(id: string, title: string, body: string, paths: string[]): Guideline {
  return {
    id,
    severity: "MINOR",
    title,
    body,
    sourcePath: `guidelines/${id}.md`,
    languages: [],
    paths,
    tags: [],
  };
}

/** The consumer's guideline wording, each sentence a check quotes included. */
const GUIDELINES: Readonly<Record<GuidelineCheck, Guideline>> = {
  selectors: guideline(
    "prefer-test-ids",
    "Test ids before roles, CSS selectors only as a last resort",
    "Test ids outlast styling changes; CSS classes outlast nothing. Where a CSS selector is unavoidable, a comment next to it gives the reason.",
    ["pages/**"],
  ),
  comments: guideline(
    "natural-comments",
    "One plain single-line comment",
    "A comment adds what the code does not show. It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.\nAny punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line unless it is a doc comment.",
    [],
  ),
  assertions: guideline(
    "web-first-assertions",
    "Assert with retrying matchers, not with read-once values",
    "A value read once with isVisible() is a snapshot that flakes on a slow render. An assertion hands expect the locator itself and lets a web first matcher wait, never the awaited value of a getter.",
    ["tests/**"],
  ),
  tags: guideline(
    "axis-tags",
    "Axis tags limit where a test runs",
    "Tags belong in the tag option, never in the test title.\n\nEach test also names one feature tag listed under `tags.features`. A test carries only axis tags and the feature tags the config declares, never `@smoke` or another tag the config does not list.",
    ["tests/**"],
  ),
  timeouts: guideline(
    "no-inline-timeouts",
    "No hard-coded waits",
    "Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place. waitForTimeout has no valid use.",
    [],
  ),
  numbers: guideline(
    "no-magic-numbers",
    "No inline timeouts, sleeps or magic numbers",
    "Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.",
    [],
  ),
  rows: guideline(
    "data-rows-not-copies",
    "Data rows instead of copied scenarios",
    "Duplicated tests diverge once a fix reaches only one copy. Sites, products, payment methods and addresses become data rows of one scenario.",
    ["tests/**"],
  ),
};

/** One changed file per check, each line added. */
const SOURCES: Readonly<Record<GuidelineCheck, { file: string; text: string }>> = {
  selectors: {
    file: "pages/pdp.ts",
    text: "export class Pdp {\n  chartLink(): Locator {\n    return this.page.locator('div.pdp > span a');\n  }\n}\n",
  },
  comments: {
    file: "support/cart.ts",
    text: "// the cart total - after tax\n// and a second line\nexport const total = 1;\n",
  },
  assertions: {
    file: "tests/smoke/cart.spec.ts",
    text: "test('the cart shows a line', async ({ page }) => {\n  expect(await page.getByTestId('line').isVisible()).toBe(true);\n});\n",
  },
  tags: {
    file: "tests/smoke/home.spec.ts",
    text: "test('the start page opens @cart', async ({ home }) => {\n  await home.open();\n});\n",
  },
  timeouts: {
    file: "support/wait.ts",
    text: "export async function settle(page: Page): Promise<void> {\n  await page.waitForTimeout(2500);\n  await expect(page.getByTestId('x')).toBeVisible({ timeout: 6000 });\n}\n",
  },
  numbers: {
    file: "src/retry.ts",
    text: "export const attempts = (options: { tries?: number }) => options.tries ?? 3;\n",
  },
  rows: {
    file: "tests/smoke/cart.spec.ts",
    text: "test('the EU cart', async ({ cart }) => {\n  await cart.open('EU');\n});\ntest('the US cart', async ({ cart }) => {\n  await cart.open('US');\n});\n",
  },
};

function added(file: string, text: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/** A judge confirming on the guideline title: the declared sentence still wins. */
function confirming(title: string): ModelPort {
  return {
    complete: () =>
      Promise.resolve({
        text: JSON.stringify({ verdict: "confirm", guidelineQuote: title, reason: null }),
      }),
  };
}

async function findingsOf(check: GuidelineCheck): Promise<Violation[]> {
  const bound = GUIDELINES[check];
  const { file, text } = SOURCES[check];
  const outcome = await runChecks({
    bound: [{ guideline: bound, check }],
    diff: added(file, text),
    read: (path) => (path === file ? text : undefined),
    files: () => [file],
    configFiles: [],
    port: () => confirming(bound.title),
    redact: (value) => value,
  });
  return outcome.findings;
}

describe("every check quotes the sentence it declares", () => {
  const cases = Object.keys(GUIDELINES) as GuidelineCheck[];

  it.each(cases)("the %s check", async (check) => {
    const findings = await findingsOf(check);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      const shape = Object.entries(CHECK_SENTENCES[check]).find(
        ([, sentence]) => sentence === finding.guidelineQuote,
      );
      expect(shape, `${finding.file}:${String(finding.line)}`).toBeDefined();
      expect(quotesGuideline(finding.guidelineQuote, GUIDELINES[check])).toBe(true);
      const line = `Guideline: ${String(finding.guidelineQuote)}`;
      expect(renderCommentBody(finding, "abc123")).toContain(`\n\n${line}`);
      const report = buildInsightReport({
        findings: [finding],
        proposals: [],
        droppedUncited: 0,
        filtered: 0,
        gate: { failed: false, threshold: "MAJOR", failing: 0 },
      });
      expect(report.annotations[0]?.summary.endsWith(line)).toBe(true);
      const [, record] = ledgerRecords({
        at: "t",
        author: "Ada",
        addedLines: 1,
        findings: [finding],
        misquoted: 0,
        attribution: {},
      });
      expect(record).toMatchObject({ kind: "finding", guidelineQuote: finding.guidelineQuote });
    }
  });

  it("names each shape's sentence", async () => {
    const timeouts = await findingsOf("timeouts");
    expect(timeouts.map((finding) => finding.guidelineQuote)).toEqual([
      "waitForTimeout has no valid use.",
      sentenceOf("timeouts", "inline-timeout"),
    ]);
    const tags = await findingsOf("tags");
    expect(tags[0]?.guidelineQuote).toBe("Tags belong in the tag option, never in the test title.");
    expect(() => sentenceOf("tags", "css")).toThrow("declares no sentence for css");
  });
});

describe("the startup validation of check sentences", () => {
  it("passes when every bound guideline says its check's sentences", () => {
    const bindings = Object.fromEntries(
      Object.entries(GUIDELINES).map(([check, bound]) => [bound.id, check as GuidelineCheck]),
    );
    expect(checkSentenceProblems(Object.values(GUIDELINES), bindings)).toEqual([]);
  });

  it("fails a check whose sentence the guideline file lacks, and ignores unbound guidelines", () => {
    const reworded: Guideline = {
      ...GUIDELINES.timeouts,
      body: "Waits longer than the framework defaults live as named values in one timeouts module, which then explains every slow run in one place. Never sleep.",
    };
    const problems = checkSentenceProblems([reworded, GUIDELINES.selectors], {
      "no-inline-timeouts": "timeouts",
    });
    expect(problems).toEqual([
      'review.checks: no-inline-timeouts is bound to the timeouts check, which quotes "waitForTimeout has no valid use.", but guidelines/no-inline-timeouts.md does not say it word for word; add the sentence or unbind the check',
    ]);
  });

  it("reports a sentence shared by two shapes once", () => {
    const bare = { ...GUIDELINES.selectors, body: "CSS is a last resort." };
    expect(checkSentenceProblems([bare], { "prefer-test-ids": "selectors" })).toHaveLength(1);
  });
});

describe("the guideline line", () => {
  it("renders only for a violation that quotes a sentence", () => {
    const violation: Violation = {
      kind: "violation",
      guidelineId: "g",
      severity: "MINOR",
      file: "a.ts",
      line: 1,
      title: "t",
      body: "b",
    };
    expect(guidelineLine(violation)).toBeUndefined();
    expect(guidelineLine({ ...violation, guidelineQuote: "  " })).toBeUndefined();
    expect(guidelineLine({ ...violation, guidelineQuote: "Use the\n logger." })).toBe(
      "Guideline: Use the logger.",
    );
    expect(guidelineLine({ ...violation, kind: "observation" } as never)).toBeUndefined();
  });

  it("keeps the guideline line whole in a long annotation and cuts the reason", () => {
    const finding: Violation = {
      kind: "violation",
      guidelineId: "g",
      severity: "MINOR",
      file: "a.ts",
      line: 1,
      title: "t",
      body: `${"word ".repeat(120)}end.`,
      guidelineQuote: "Use the logger instead of console output.",
    };
    const input = {
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { failed: false, threshold: "MAJOR" as const, failing: 0 },
    };
    const long = buildInsightReport({ ...input, findings: [finding] }).annotations[0]?.summary;
    expect(long?.length).toBe(450);
    expect(long?.endsWith(" Guideline: Use the logger instead of console output.")).toBe(true);
    const huge = { ...finding, guidelineQuote: "x".repeat(500) };
    const clipped = buildInsightReport({ ...input, findings: [huge] }).annotations[0]?.summary;
    expect(clipped).toBe(`Guideline: ${"x".repeat(500)}`.slice(0, 450));
    const plain: Violation = { ...finding };
    delete plain.guidelineQuote;
    const bare = buildInsightReport({ ...input, findings: [plain] }).annotations[0]?.summary;
    expect(bare?.length).toBe(450);
  });
});
