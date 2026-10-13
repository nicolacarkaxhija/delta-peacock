import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Observation, Violation } from "../src/domain/finding.js";
import { runCli } from "../src/index.js";
import type { ReviewReport } from "../src/review/report.js";
import { dropAlreadyHeld } from "../src/review/placement.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const violation = (body: string, quote: string): Violation => ({
  kind: "violation",
  guidelineId: "known-failures-need-a-ticket",
  severity: "MAJOR",
  file: "tests/export.spec.ts",
  line: 12,
  title: "Mute reason format",
  body,
  quote,
});

const LINE = "    'tenant b drops emoji on export; muted until 2026-11-20',";

describe("dropAlreadyHeld", () => {
  it("drops a finding asking the line to end with text it already ends with", () => {
    const finding = violation(
      "The current reason ends with 'muted until 2026-11-20' but should end with 'until 2026-11-20' to match the guideline.",
      LINE,
    );
    const result = dropAlreadyHeld([finding]);
    expect(result.kept).toEqual([]);
    expect(result.dropped[0]?.reason).toBe("already-held");
  });

  it("drops a finding asking the line to contain text it already contains", () => {
    const finding = violation("The reason must include `drops emoji` so the fault is named.", LINE);
    expect(dropAlreadyHeld([finding]).kept).toEqual([]);
  });

  it("keeps a finding asking for a date the line does not hold", () => {
    const finding = violation(
      "The reason should end with 'until 2026-11-19', the date the setting expires.",
      LINE,
    );
    expect(dropAlreadyHeld([finding]).kept).toEqual([finding]);
  });

  it("keeps a finding asking the line to end with text it holds only in the middle", () => {
    const finding = violation("The reason should end with 'tenant b'.", LINE);
    expect(dropAlreadyHeld([finding]).kept).toEqual([finding]);
  });

  it("keeps a finding that demands no quoted text", () => {
    const finding = violation("The skip has no expiry date.", LINE);
    expect(dropAlreadyHeld([finding]).kept).toEqual([finding]);
  });

  it("drops an observation the same way, with no guideline on the record", () => {
    const observation: Observation = {
      kind: "observation",
      severity: "MINOR",
      file: "tests/export.spec.ts",
      line: 12,
      title: "Reason format",
      body: "It must end with 'until 2026-11-20'.",
      quote: LINE,
    };
    const result = dropAlreadyHeld([observation]);
    expect(result.kept).toEqual([]);
    expect(result.dropped[0]?.guidelineId).toBeUndefined();
  });

  it("keeps a finding without a quoted line", () => {
    const finding: Violation = { ...violation("It should end with 'until 2026-11-20'.", LINE) };
    delete finding.quote;
    expect(dropAlreadyHeld([finding]).kept).toEqual([finding]);
  });
});

const GUIDELINE = `---
id: known-failures-need-a-ticket
severity: MAJOR
---
# A muted test says why and until when

A mute reason names the fault and ends with \`until <date>\`.
`;

const SPEC = [
  "test('an exported note keeps its emoji', async ({ notes, settings }) => {",
  "  test.skip(",
  "    settings.muted('exportMuted'),",
  LINE,
  "  );",
  "});",
  "",
].join("\n");

describe("a review whose finding asks for text its line already holds", () => {
  it("drops it before anything is posted, and the log says why", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/known-failures-need-a-ticket.md", GUIDELINE);
    commitAll(repo, "rules");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "tests/export.spec.ts", SPEC);
    commitAll(repo, "mute");
    const reply = JSON.stringify({
      findings: [
        {
          guidelineId: "known-failures-need-a-ticket",
          file: "tests/export.spec.ts",
          line: 4,
          quote: LINE,
          guidelineQuote: "A mute reason names the fault and ends with `until <date>`.",
          title: "Mute reason format",
          body: "The reason ends with 'muted until 2026-11-20' but should end with 'until 2026-11-20'.",
        },
      ],
    });
    let stderr = "";
    const code = await runCli(["review", "--report", "r.json"], {
      cwd: repo,
      env: {},
      out: () => undefined,
      err: (text) => {
        stderr += text;
      },
      modelPort: { complete: () => Promise.resolve({ text: reply }) },
    });
    expect(code).toBe(0);
    expect(stderr).toContain("1 finding(s) dropped: the line already holds the text they ask for");
    const report = JSON.parse(readFileSync(path.join(repo, "r.json"), "utf8")) as ReviewReport;
    expect(report.findings).toEqual([]);
    expect(report.rejectedCandidates?.map((entry) => entry.reason)).toEqual(["already-held"]);
  });
});
