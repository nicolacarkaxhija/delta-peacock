import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import type { ModelPort } from "../src/model/port.js";
import { findCandidates } from "../src/review/checks/detect.js";
import { settle } from "../src/review/checks/judge.js";
import {
  numberCandidates,
  numberLiterals,
  shellNumberLiterals,
} from "../src/review/checks/numbers.js";
import { impliedCheck } from "../src/review/checks/rules.js";

const RULE =
  "Every timeout, delay, retry count, limit or threshold is a named constant declared once, next to the reason it has that value, so one place answers why the code waits or stops where it does.";

const NUMBERS: Guideline = {
  id: "no-magic-numbers",
  severity: "MAJOR",
  title: "No inline timeouts, sleeps or magic numbers",
  body: `${RULE} Zero, one and minus one as plain arithmetic are fine.`,
  sourcePath: "guidelines/no-magic-numbers.md",
  languages: ["typescript", "javascript", "shell"],
  paths: ["src/**", "scripts/**"],
  tags: [],
};

const all = (text: string): Set<number> => new Set(text.split("\n").map((_, index) => index + 1));
const lines = (text: string) =>
  numberCandidates(NUMBERS, "src/model/jev.ts", text, all(text)).map(
    (one) => `${String(one.line)} ${one.shape} ${one.title}`,
  );

describe("numeric literals in code", () => {
  it("reads template expressions and regex quantifiers, never comments or strings", () => {
    const text = [
      "// wait 30 seconds",
      'const label = "take 5";',
      "throw new Error(`jev answered ${String(status)}: ${text.slice(0, 200)}`);",
      "const words = text.match(/[a-z]{4,}/g);",
      "const range = /x{2,9}/;",
    ].join("\n");
    expect(numberLiterals(text).map((one) => `${String(one.line)}:${one.text}`)).toEqual([
      "3:0",
      "3:200",
      "4:4",
      "5:2",
      "5:9",
    ]);
  });

  it("leaves out positional parameters, redirects and comments in shell", () => {
    const text = ["# 14 days", "days=${1:-14}", 'echo "$2" >&2 2>/dev/null', "sleep 5 # why"].join(
      "\n",
    );
    expect(shellNumberLiterals(text).map((one) => `${String(one.line)}:${one.text}`)).toEqual([
      "2:14",
      "4:5",
    ]);
  });
});

describe("the numbers check", () => {
  it("is implied by the guideline's own sentence", () => {
    expect(impliedCheck(NUMBERS)).toBe("numbers");
  });

  it("flags inline limits, backoff and timeouts, never zero, one, unit factors or indexes", () => {
    const text = [
      "const wanted = header > 0 ? header * 1000 : 250 * 2 ** attempt;",
      "return Math.min(wanted, 5000);",
      "const attempts = options.attempts ?? 3;",
      "signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),",
      "stopWhen: stepCountIs(rounds + 1),",
      "const second = parts[2];",
      "const seconds = ms / 1000;",
    ].join("\n");
    expect(lines(text)).toEqual([
      "1 inline-number Inline number 250, 2",
      "2 inline-number Inline number 5000",
      "3 inline-number Inline number 3",
      "4 inline-number Inline number 15_000",
    ]);
  });

  it("gives the judge every comment next to a named constant, whatever its words", () => {
    const text = [
      "/** Lines read after the flagged one for the rest of a test title. */",
      "const TITLE_REACH = 3;",
      "",
      "/** The API pages by 50. */",
      "const PAGE_SIZE = 50;",
      "",
      "const TITLE_MAX = 255; // Bitbucket rejects longer titles",
    ].join("\n");
    const found = numberCandidates(NUMBERS, "src/scm/limits.ts", text, all(text));
    expect(found.map((one) => one.judge?.comments.map((comment) => comment.text))).toEqual([
      ["Lines read after the flagged one for the rest of a test title."],
      ["The API pages by 50."],
      ["Bitbucket rejects longer titles"],
    ]);
  });

  it("settles a constant whose comment names the document it follows or what a smaller or larger value fails", () => {
    const text = [
      "/** RFC 7636 asks for 43 to 128 characters. */",
      "const VERIFIER_MAX = 128;",
      "/** The stale age docs/contributing.md sets. */",
      "const STALE_DAYS = 14;",
      "// Page size per https://docs.example.com/api/paging.",
      "const PAGE_SIZE = 50;",
      "// long enough to name the rejected fields of a 400, short enough to keep the error one readable line",
      "const DETAIL_LIMIT = 300;",
      "// Enough of an error body to name the cause, short enough for one log line.",
      "const ERROR_EXCERPT_CHARS = 200;",
      "/** Passes in flight at once; a focused review fans out one call per guideline. */",
      "const PASS_CONCURRENCY = 4;",
      "// Checks a change against docs/contributing.md: branch name and title.",
      "const TITLE_REACH = 3;",
    ].join("\n");
    expect(lines(text)).toEqual([
      "12 unexplained-constant No reason next to PASS_CONCURRENCY",
      "14 unexplained-constant No reason next to TITLE_REACH",
    ]);
  });

  it("leaves out formatting arguments", () => {
    const text = "const sure = confidence.toFixed(2).padStart(6);";
    expect(lines(text)).toEqual([]);
  });

  it("reads shell constants and inline defaults, a unit conversion name left out", () => {
    const text = [
      "#!/usr/bin/env sh",
      "# Lists the stale branches, oldest first.",
      "stale_days=14",
      "days=${1:-14}",
      "seconds_per_day=86400",
      "# Lists the remote branches with no commit for more than N days, oldest first.",
      "# The stale age docs/contributing.md sets.",
      "limit_days=14",
    ].join("\n");
    const found = numberCandidates(NUMBERS, "scripts/stale-branches.sh", text, all(text));
    expect(found.map((one) => `${String(one.line)} ${one.shape}`)).toEqual([
      "3 unexplained-constant",
      "4 inline-number",
    ]);
    expect(found[0]?.judge?.comments.map((one) => one.text)).toEqual([
      "Lists the stale branches, oldest first.",
    ]);
  });

  it("looks only at added lines of files the guideline covers, shell included", () => {
    const found = findCandidates([{ guideline: NUMBERS, check: "numbers" }], {
      changed: new Map([
        ["scripts/stale.sh", new Set([2])],
        ["tests/x.test.ts", new Set([1])],
      ]),
      read: (file) => (file.endsWith(".sh") ? "a=1\nsleep 30\n" : "wait(30);\n"),
      files: () => [],
      testIdAttribute: "data-testid",
    });
    expect(found.map((one) => `${one.file}:${String(one.line)}`)).toEqual(["scripts/stale.sh:2"]);
  });
});

describe("the judge on a number", () => {
  const [candidate] = numberCandidates(
    NUMBERS,
    "src/x.ts",
    "const text = body.slice(0, 200);",
    new Set([1]),
  );
  const port = (text: string): ModelPort => ({
    complete: () => Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } }),
  });

  it("drops a number that is none of the kinds, on the guideline sentence", async () => {
    if (candidate === undefined) throw new Error("no candidate");
    const outcome = await settle(
      port(
        JSON.stringify({ verdict: "drop", kind: "none", guidelineQuote: RULE, reason: "a slice" }),
      ),
      candidate,
      NUMBERS,
      "",
    );
    expect(outcome.outcome).toBe("dropped");
    expect(outcome.rejected?.reason).toBe("judge-outside");
  });

  it("lets a constant's comment settle it only when the judge says it gives a cause", async () => {
    const [named] = numberCandidates(
      NUMBERS,
      "src/x.ts",
      "/** The API pages by 50. */\nconst PAGE_SIZE = 50;",
      new Set([2]),
    );
    if (named === undefined) throw new Error("no candidate");
    const drop = (says: string) =>
      port(
        JSON.stringify({
          kind: "limit",
          says,
          verdict: "drop",
          guidelineQuote: RULE,
          comment: "The API pages by 50.",
        }),
      );
    expect((await settle(drop("why"), named, NUMBERS, "")).outcome).toBe("dropped");
    expect((await settle(drop("what"), named, NUMBERS, "")).outcome).toBe("finding");
  });

  it("keeps an inline number of a named kind, whatever the verdict", async () => {
    if (candidate === undefined) throw new Error("no candidate");
    const outcome = await settle(
      port(JSON.stringify({ verdict: "drop", kind: "limit", guidelineQuote: RULE })),
      candidate,
      NUMBERS,
      "",
    );
    expect(outcome.outcome).toBe("finding");
  });

  it("drops on a none kind whatever it quotes, and keeps the rule sentence on a finding", async () => {
    if (candidate === undefined) throw new Error("no candidate");
    const dropped = await settle(
      port(JSON.stringify({ verdict: "drop", kind: "none", guidelineQuote: "numbers are fine" })),
      candidate,
      NUMBERS,
      "",
    );
    expect(dropped.outcome).toBe("dropped");
    const kept = await settle(
      port(JSON.stringify({ verdict: "confirm", kind: "limit", guidelineQuote: "a title" })),
      candidate,
      NUMBERS,
      "",
    );
    expect(kept.finding?.guidelineQuote).toBe(RULE);
  });
});
