import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import type { GateDecision } from "../src/domain/gate.js";
import type { Severity } from "../src/domain/severity.js";
import {
  renderSummaryBody,
  stateLine,
  statusLine,
  type SummaryInput,
} from "../src/scm/comment-format.js";
import { buildInsightReport } from "../src/scm/publish.js";

const PASSING: GateDecision = { threshold: "MAJOR", failing: 0, failed: false };
const FAILING: GateDecision = { threshold: "MAJOR", failing: 1, failed: true };

const violation = (severity: Severity): Finding => ({
  kind: "violation",
  guidelineId: "no-console",
  severity,
  file: "src/b.js",
  line: 1,
  title: "Console call added",
  body: "Replace it with the logger.",
});

const input = (overrides: Partial<SummaryInput>): SummaryInput => ({
  findings: [],
  proposals: [],
  droppedUncited: 0,
  filtered: 0,
  gate: PASSING,
  changedFiles: 3,
  unreviewed: { files: ["src/a.js", "src/c.js"], status: "success" },
  ...overrides,
});

describe("stateLine", () => {
  it("counts the reviewed files and asks for a person's approval when the status posted is pending", () => {
    expect(
      stateLine(input({ unreviewed: { files: ["src/a.js", "src/c.js"], status: "pending" } })),
    ).toBe(
      "Reviewed 1 of 3 changed files, no findings. 2 files not reviewed: reply unparseable. Merging needs a person's approval.",
    );
  });

  it("says nothing of approval when the status posted is success", () => {
    expect(stateLine(input({}))).toBe(
      "Reviewed 1 of 3 changed files, no findings. 2 files not reviewed: reply unparseable.",
    );
  });

  it("says nothing of approval when the gate failed, so the posted status is failed", () => {
    expect(
      stateLine(input({ gate: FAILING, unreviewed: { files: ["src/a.js"], status: "pending" } })),
    ).not.toContain("approval");
  });

  it("names a file the output cap cut off as such", () => {
    expect(
      stateLine(
        input({ unreviewed: { files: ["src/a.js"], capHit: ["src/a.js"], status: "success" } }),
      ),
    ).toBe("Reviewed 2 of 3 changed files, no findings. 1 file not reviewed: output cap hit.");
  });

  it("names both reasons when the files differ", () => {
    expect(
      stateLine(
        input({
          unreviewed: { files: ["src/a.js", "src/c.js"], capHit: ["src/a.js"], status: "success" },
        }),
      ),
    ).toBe(
      "Reviewed 1 of 3 changed files, no findings. 2 files not reviewed: reply unparseable or output cap hit.",
    );
  });

  it("counts the findings of the reviewed files", () => {
    const findings = [violation("MAJOR"), violation("MINOR")];
    expect(
      stateLine(input({ findings, unreviewed: { files: ["src/a.js"], status: "success" } })),
    ).toBe(
      "Reviewed 2 of 3 changed files, 2 findings: 1 major, 1 minor. 1 file not reviewed: reply unparseable.",
    );
  });

  it("counts the unreviewed files alone when the changed files are not known", () => {
    const unknown = input({});
    delete unknown.changedFiles;
    expect(stateLine(unknown)).toBe(
      "Reviewed 0 of 2 changed files, no findings. 2 files not reviewed: reply unparseable.",
    );
  });

  it("leaves a facts only run its own line", () => {
    expect(stateLine(input({ factsOnly: { left: 0, notReviewed: [] } }))).toMatch(
      /^This review checked facts only/,
    );
  });
});

describe("statusLine", () => {
  it("passes and names how many files were not reviewed", () => {
    expect(statusLine(input({}))).toBe(
      "Passed. Reviewed 1 of 3 changed files; 2 not reviewed: reply unparseable.",
    );
  });

  it("counts the unreviewed files alone when the changed files are not known", () => {
    const unknown = input({});
    delete unknown.changedFiles;
    expect(statusLine(unknown)).toBe(
      "Passed. Reviewed 0 of 2 changed files; 2 not reviewed: reply unparseable.",
    );
  });

  it("names the output cap in the status", () => {
    expect(
      statusLine(
        input({ unreviewed: { files: ["src/a.js"], capHit: ["src/a.js"], status: "success" } }),
      ),
    ).toBe("Passed. Reviewed 2 of 3 changed files; 1 not reviewed: output cap hit.");
  });

  it("asks for a person's approval with fallback.status pending", () => {
    expect(statusLine(input({ unreviewed: { files: ["src/a.js"], status: "pending" } }))).toBe(
      "Passed. Reviewed 2 of 3 changed files; 1 not reviewed: reply unparseable. Needs a person's approval.",
    );
  });

  it("leads with the findings when the reviewed files have any", () => {
    expect(statusLine(input({ findings: [violation("MAJOR")], gate: FAILING }))).toBe(
      "1 finding, 1 major. Reviewed 1 of 3 changed files; 2 not reviewed: reply unparseable.",
    );
  });

  it("says nothing of approval when the gate already failed", () => {
    expect(
      statusLine(
        input({
          findings: [violation("MAJOR")],
          gate: FAILING,
          unreviewed: { files: ["src/a.js"], status: "pending" },
        }),
      ),
    ).toBe("1 finding, 1 major. Reviewed 2 of 3 changed files; 1 not reviewed: reply unparseable.");
  });
});

describe("renderSummaryBody", () => {
  it("lists every file not reviewed under the first line, even with a clean scope", () => {
    const body = renderSummaryBody(
      input({
        scope: { changed: 3, excluded: [], outsideInclude: 0 },
        unreviewed: { files: ["src/a.js", "src/c.js"], capHit: ["src/c.js"], status: "success" },
      }),
    );
    expect(body).toBe(
      [
        "Reviewed 1 of 3 changed files, no findings. 2 files not reviewed: reply unparseable or output cap hit.",
        "",
        "- src/a.js: not reviewed: reply unparseable",
        "- src/c.js: not reviewed: output cap hit",
        "",
        "<!-- delta-peacock:summary -->",
      ].join("\n"),
    );
  });
});

describe("buildInsightReport", () => {
  it("is pending with fallback.status pending and passed otherwise", () => {
    expect(buildInsightReport(input({})).result).toBe("PASSED");
    expect(
      buildInsightReport(input({ unreviewed: { files: ["src/a.js"], status: "pending" } })).result,
    ).toBe("PENDING");
    expect(
      buildInsightReport(
        input({
          findings: [violation("MAJOR")],
          gate: FAILING,
          unreviewed: { files: ["src/a.js"], status: "pending" },
        }),
      ).result,
    ).toBe("FAILED");
  });
});
