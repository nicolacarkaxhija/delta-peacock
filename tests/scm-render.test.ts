import { describe, expect, it } from "vitest";
import type { Violation } from "../src/domain/finding.js";
import { renderSummaryBody } from "../src/scm/publish.js";

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    kind: "violation",
    guidelineId: "no-console",
    severity: "MAJOR",
    file: "src/app.js",
    line: 2,
    title: "Console call",
    body: "Use the logger.",
    ...overrides,
  };
}

describe("summary rendering", () => {
  it("shows a failed gate with its threshold and count", () => {
    const body = renderSummaryBody({
      findings: [violation()],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { threshold: "MAJOR", failing: 1, failed: true },
    });
    expect(body).toContain("failOn=MAJOR FAILED (1)");
    expect(body).toContain("| MAJOR | 1 |");
  });

  it("shows a passed gate", () => {
    const body = renderSummaryBody({
      findings: [violation({ severity: "INFO" })],
      proposals: [],
      droppedUncited: 0,
      filtered: 0,
      gate: { threshold: "MAJOR", failing: 0, failed: false },
    });
    expect(body).toContain("failOn=MAJOR passed");
  });

  it("lists proposed guidelines and the filtering footnote", () => {
    const body = renderSummaryBody({
      findings: [],
      proposals: [{ id: "no-magic", severity: "MINOR", rationale: "recurring" }],
      droppedUncited: 2,
      filtered: 1,
      gate: { threshold: "none", failing: 0, failed: false },
    });
    expect(body).toContain("### Proposed guidelines");
    expect(body).toContain("`no-magic` (MINOR): recurring");
    expect(body).toContain("1 finding(s) under the confidence floor");
    expect(body).toContain("2 uncited finding(s) dropped");
  });
});
