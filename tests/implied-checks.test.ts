import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { splitChecked } from "../src/review/checks/index.js";
import { impliedCheck } from "../src/review/checks/rules.js";
import type { ReviewReport } from "../src/review/report.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const MULTI =
  "Any punctuation may appear, semicolons as well, except dashes and doubled hyphens, and a comment never runs past a single line.";
const DASH =
  "It says nothing about how the change was made, the work session or who wrote it, and it separates clauses with commas or colons instead of dashes.";

const guideline = (id: string, body: string): Guideline => ({
  id,
  severity: "MINOR",
  title: "One plain single-line comment",
  body,
  sourcePath: `guidelines/${id}.md`,
  languages: [],
  paths: [],
  tags: [],
});

describe("a guideline that says a check's sentences", () => {
  it("is checked by that check without a binding", () => {
    expect(impliedCheck(guideline("natural-comments", `${DASH}\n${MULTI}`))).toBe("comments");
    const { bound, free } = splitChecked([guideline("natural-comments", `${DASH} ${MULTI}`)], {});
    expect(bound.map((one) => `${one.guideline.id}:${one.check}`)).toEqual([
      "natural-comments:comments",
    ]);
    expect(free).toEqual([]);
  });

  it("stays free when it says only some of them", () => {
    expect(impliedCheck(guideline("natural-comments", DASH))).toBeUndefined();
    expect(splitChecked([guideline("natural-comments", DASH)], {}).free).toHaveLength(1);
  });

  it("keeps an explicit binding over the implied one", () => {
    const { bound } = splitChecked([guideline("natural-comments", `${DASH} ${MULTI}`)], {
      "natural-comments": "selectors",
    });
    expect(bound.map((one) => one.check)).toEqual(["selectors"]);
  });
});

const COMMENTS_MD = `---
id: natural-comments
severity: MINOR
languages: [typescript]
paths: ["src/**"]
---
# One plain single-line comment

A comment adds what the code does not show. ${DASH}
${MULTI}
`;

const CONFIG = `review:
  target: main
  fetchTarget: false
`;

const SOURCE = [
  "export function read(file: string): string {",
  "  // a committed symlink (say to /proc/self/environ) must never reach the model",
  "  return file;",
  "}",
  "",
  "/**",
  " * The first reply is garbage, twice (a parse failure is retried once);",
  " * the second answers cleanly.",
  " */",
  "export const flaky = 1;",
  "",
].join("\n");

function scripted(...texts: string[]): { port: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      complete(request) {
        requests.push(request);
        const text = texts[Math.min(requests.length - 1, texts.length - 1)] ?? "";
        return Promise.resolve({ text, usage: { inputTokens: 100, outputTokens: 20 } });
      },
    },
  };
}

describe("a review whose config binds no check", () => {
  it("settles dash and line count claims by the check the guideline's words imply", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/natural-comments.md", COMMENTS_MD);
    write(
      repo,
      "guidelines/no-console.md",
      "---\nid: no-console\nseverity: MAJOR\nlanguages: [typescript]\n---\n# No console statements\n\nUse the logger instead.\n",
    );
    write(repo, "delta-peacock.config.yaml", CONFIG);
    commitAll(repo, "guidelines");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/read.ts", SOURCE);
    commitAll(repo, "change");
    const claim = (line: number, quote: string) => ({
      guidelineId: "natural-comments",
      file: "src/read.ts",
      line,
      quote,
      guidelineQuote: DASH,
      title: "Comment uses dashes as punctuation",
      body: "Replace the dashes with commas or colons.",
    });
    const { port } = scripted(
      JSON.stringify({
        findings: [
          claim(
            2,
            "  // a committed symlink (say to /proc/self/environ) must never reach the model",
          ),
          claim(7, " * The first reply is garbage, twice (a parse failure is retried once);"),
        ],
      }),
    );
    let err = "";
    await runCli(["review", "--report", "review.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      modelPort: port,
    });
    const written = JSON.parse(
      readFileSync(path.join(repo, "review.json"), "utf8"),
    ) as ReviewReport;
    expect(err).toContain("their guideline is checked");
    expect(written.findings.map((one) => `${String(one.line)} ${one.title}`)).toEqual([
      "6 Comment spans 4 lines",
    ]);
  });
});
