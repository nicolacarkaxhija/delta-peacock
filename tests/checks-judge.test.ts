import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { runChecks, splitChecked } from "../src/review/checks/index.js";
import type { Candidate } from "../src/review/checks/detect.js";
import {
  agreesWithCatalog,
  excerptOf,
  judgeRequest,
  ruleSentence,
  settle,
} from "../src/review/checks/judge.js";

const PREFER: Guideline = {
  id: "prefer-test-ids",
  severity: "MINOR",
  title: "getByTestId first, then role and name, CSS last",
  body: [
    "A test id survives restyling; a CSS class survives neither. A CSS selector carries a comment saying why nothing better exists.",
    "The comment may sit on the same line, on the line above, or in the doc comment of the enclosing declaration.",
    "",
    "Good:",
    "",
    "```ts",
    "return this.testId('x'); // A CSS selector here.",
    "```",
  ].join("\n"),
  sourcePath: "guidelines/prefer-test-ids.md",
  languages: [],
  paths: ["pages/**"],
  tags: [],
  pack: "suite",
};

const COMMENTS: Guideline = {
  id: "natural-comments",
  severity: "MINOR",
  title: "Comments are one short natural line",
  body: "It never narrates the change, the session or the author, and it uses commas or colons, not dashes.",
  sourcePath: "guidelines/natural-comments.md",
  languages: [],
  paths: [],
  tags: [],
};

const JUDGED: Candidate = {
  guidelineId: "prefer-test-ids",
  check: "selectors",
  shape: "css",
  file: "pages/pdp.ts",
  line: 4,
  quote: "    return this.page.getByTestId('g').locator('img');",
  title: "CSS selector without a reason",
  body: "Literal body.",
  judge: {
    question: "Does one of these comments say why?",
    comments: [{ line: 2, text: "Every image the carousel holds; it keeps every slide." }],
    fact: "`'img'` is a CSS selector.",
    fix: "Use getByTestId or getByRole.",
  },
};

const RULE = "A CSS selector carries a comment saying why nothing better exists.";

function scripted(...texts: (string | Error)[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let next = 0;
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const text = texts[Math.min(next, texts.length - 1)] ?? "";
        next += 1;
        if (text instanceof Error) return Promise.reject(text);
        return Promise.resolve({ text, usage: { inputTokens: 10, outputTokens: 5 } });
      },
    },
  };
}

const verdict = (fields: Record<string, string>): string => JSON.stringify(fields);

describe("the rule sentence a checked finding quotes", () => {
  it("picks the sentence that names the shape, else the title", () => {
    expect(ruleSentence(PREFER, "css")).toBe(RULE);
    expect(ruleSentence(COMMENTS, "multi-line")).toBe("Comments are one short natural line");
    expect(ruleSentence(COMMENTS, "dash")).toContain("not dashes.");
    expect(ruleSentence(COMMENTS, "snapshot")).toBe(COMMENTS.title);
    const fenced: Guideline = {
      ...COMMENTS,
      body: "```ts\n// one short line\n```\n# Heading\nA comment stays one line, always.",
    };
    expect(ruleSentence(fenced, "multi-line")).toBe(COMMENTS.title);
    expect(ruleSentence({ ...fenced, title: "Comments" }, "multi-line")).toBe(
      "A comment stays one line, always.",
    );
  });
});

describe("settling a candidate", () => {
  it("makes a measured fact a finding without a model call", async () => {
    const literal: Candidate = { ...JUDGED, suggestion: "x" };
    delete literal.judge;
    const outcome = await settle(undefined, literal, PREFER, "");
    expect(outcome.outcome).toBe("finding");
    expect(outcome.finding).toMatchObject({
      guidelineId: "prefer-test-ids",
      pack: "suite",
      body: "Literal body.",
      guidelineQuote: RULE,
      suggestion: "x",
      confidence: 1,
    });
    expect(outcome.notice).toBe("check: pages/pdp.ts:4 prefer-test-ids css: finding");
  });

  it("keeps the judge's reason when it names nothing the catalog does not", async () => {
    const { port, requests } = scripted(
      verdict({
        verdict: "confirm",
        guidelineQuote: RULE,
        reason: "The comment says what, not why",
      }),
    );
    const outcome = await settle(port, JUDGED, PREFER, "excerpt");
    expect(outcome.finding?.body).toBe(
      "`'img'` is a CSS selector. The comment says what, not why. Use getByTestId or getByRole.",
    );
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(requests[0]?.user).toContain(
      '- line 2: "Every image the carousel holds; it keeps every slide."',
    );
    expect(requests[0]?.temperature).toBe(0);
  });

  it("drops model prose that names another matcher and replaces a misquoted rule", async () => {
    const { port } = scripted(
      verdict({
        verdict: "confirm",
        guidelineQuote: "CSS is banned.",
        reason: "Use toHaveAttribute instead",
      }),
    );
    const outcome = await settle(port, JUDGED, PREFER, "");
    expect(outcome.finding?.body).toBe("Literal body.");
    expect(outcome.finding?.guidelineQuote).toBe(RULE);
  });

  it("drops a candidate only on a verbatim rule and a listed comment", async () => {
    const drop = verdict({
      verdict: "drop",
      guidelineQuote: RULE,
      comment: "// Every image the carousel holds; it keeps every slide.",
    });
    const dropped = await settle(scripted(drop).port, JUDGED, PREFER, "");
    expect(dropped.outcome).toBe("dropped");
    expect(dropped.rejected?.reason).toBe("judge-drop");
    const invented = verdict({
      verdict: "drop",
      guidelineQuote: RULE,
      comment: "An unlisted reason of ours.",
    });
    const kept = await settle(scripted(invented).port, JUDGED, PREFER, "");
    expect(kept.outcome).toBe("finding");
    expect(kept.notice).toContain("cites no listed comment");
    const short = verdict({ verdict: "drop", guidelineQuote: RULE, comment: "Every" });
    expect((await settle(scripted(short).port, JUDGED, PREFER, "")).outcome).toBe("finding");
    const bare = JSON.stringify({ verdict: "drop", guidelineQuote: RULE, comment: null });
    expect((await settle(scripted(bare).port, JUDGED, PREFER, "")).outcome).toBe("finding");
    const nulls = JSON.stringify({ verdict: "confirm", guidelineQuote: null, reason: null });
    const confirmed = await settle(scripted(nulls).port, JUDGED, PREFER, "");
    expect(confirmed.finding?.guidelineQuote).toBe(RULE);
    expect(confirmed.finding?.body).toBe("Literal body.");
  });

  it("retries an unreadable reply once with the same request, then gives up without a finding", async () => {
    const good = verdict({ verdict: "confirm", guidelineQuote: RULE });
    const recovered = scripted("not json", good);
    expect((await settle(recovered.port, JUDGED, PREFER, "")).outcome).toBe("finding");
    expect(recovered.requests[1]).toEqual(recovered.requests[0]);
    const failed = await settle(scripted('{"verdict": "maybe"}', "no").port, JUDGED, PREFER, "");
    expect(failed.outcome).toBe("failed");
    expect(failed.rejected?.reason).toBe("judge-failed");
    expect(failed.notice).toContain("no readable verdict");
    const down = await settle(scripted(new Error("throttled\nstack")).port, JUDGED, PREFER, "");
    expect(down.notice).toContain("judge failed twice (throttled)");
    expect(down.usage).toBeUndefined();
  });

  it("agrees with the catalog only on its own forms and without dashes", () => {
    const assertion: Candidate = { ...JUDGED, check: "assertions", form: "toHaveURL" };
    expect(agreesWithCatalog("Use toHaveURL.", assertion)).toBe(true);
    expect(agreesWithCatalog("Use toBeVisible.", assertion)).toBe(false);
    expect(agreesWithCatalog("Use getByRole, it reads the name.", JUDGED)).toBe(true);
    expect(agreesWithCatalog("A locator call.", JUDGED)).toBe(false);
    expect(agreesWithCatalog("Plain - but dashed.", JUDGED)).toBe(false);
  });

  it("shows the judge the numbered lines from the comment to just past the line", () => {
    const lines = ["a", "/** doc */", "b", "flagged", "c", "d", "e"];
    expect(excerptOf(lines, JUDGED).split("\n")).toEqual([
      "     1| a",
      "     2| /** doc */",
      "     3| b",
      ">>   4| flagged",
      "     5| c",
      "     6| d",
    ]);
    const unjudged: Candidate = { ...JUDGED };
    delete unjudged.judge;
    const request = judgeRequest(unjudged, PREFER, "x");
    expect(request.user).toContain("Question: ");
  });
});

describe("running the checks", () => {
  const FILES: Record<string, string> = {
    "pages/pdp.ts": [
      "export class PdpPage {",
      "  /** Every image the carousel holds; it keeps every slide. */",
      "  images(): Locator {",
      "    return this.page.getByTestId('g').locator('img');",
      "  }",
      "  bare(): Locator {",
      "    return this.page.locator('.bare');",
      "  }",
      "}",
    ].join("\n"),
    "test-runner.config.ts": "export default { use: { testIdAttribute: 'data-tau' } };",
  };
  const DIFF = [
    "diff --git a/pages/pdp.ts b/pages/pdp.ts",
    "--- a/pages/pdp.ts",
    "+++ b/pages/pdp.ts",
    "@@ -0,0 +1,9 @@",
    ...String(FILES["pages/pdp.ts"])
      .split("\n")
      .map((line) => `+${line}`),
    "",
  ].join("\n");

  it("settles every candidate, tallies them, and builds the port only for a judge", async () => {
    const { bound, free } = splitChecked([PREFER, COMMENTS], { "prefer-test-ids": "selectors" });
    expect(free.map((one) => one.id)).toEqual(["natural-comments"]);
    let built = 0;
    const { port } = scripted("garbage", "garbage");
    const outcome = await runChecks({
      bound,
      diff: DIFF,
      read: (file) => FILES[file],
      files: () => Object.keys(FILES),
      configFiles: ["test-runner.config.ts", "playwright.config.ts"],
      port: () => {
        built += 1;
        return port;
      },
      redact: (text) => text.replace("carousel", "[redacted:x]"),
    });
    expect(built).toBe(1);
    expect(outcome.tally).toEqual({ candidates: 2, findings: 1, dropped: 0, judgeFailed: 1 });
    expect(outcome.findings.map((finding) => finding.line)).toEqual([7]);
    expect(outcome.rejected.map((entry) => entry.reason)).toEqual(["judge-failed"]);
    expect(outcome.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(outcome.notices).toHaveLength(2);
  });

  it("counts a judged drop and costs nothing when every candidate is a fact", async () => {
    const drop = verdict({
      verdict: "drop",
      guidelineQuote: RULE,
      comment: "Every image the carousel holds; it keeps every slide.",
    });
    const { bound } = splitChecked([PREFER], { "prefer-test-ids": "selectors" });
    const dropped = await runChecks({
      bound,
      diff: DIFF,
      read: (file) => FILES[file],
      files: () => [],
      declared: { source: "x", features: [], axis: [] },
      configFiles: [],
      port: () => scripted(drop).port,
      redact: (text) => text,
    });
    expect(dropped.tally).toEqual({ candidates: 2, findings: 1, dropped: 1, judgeFailed: 0 });
    const factsOnly = await runChecks({
      bound,
      diff: DIFF.replace("+  /** Every image the carousel holds; it keeps every slide. */", "+"),
      read: (file) =>
        FILES[file]?.replace("/** Every image the carousel holds; it keeps every slide. */", ""),
      files: () => [],
      configFiles: [],
      port: () => {
        throw new Error("no judge needed");
      },
      redact: (text) => text,
    });
    expect(factsOnly.tally.findings).toBe(2);
    expect(factsOnly.usage).toBeUndefined();
  });
});
