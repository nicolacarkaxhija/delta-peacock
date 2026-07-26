import { describe, expect, it } from "vitest";
import type { Severity } from "../src/domain/severity.js";
import { harvestUncited } from "../src/review/harvest.js";
import type { RejectedCandidate } from "../src/review/parse.js";

function uncited(title: string, severity?: Severity): RejectedCandidate {
  return { reason: "uncited", raw: "{}", title, ...(severity !== undefined ? { severity } : {}) };
}

describe("harvestUncited", () => {
  it("drafts a guideline when the same uncited title recurs", () => {
    const drafts = harvestUncited([uncited("Magic number", "MINOR"), uncited("magic  number")]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: "magic-number",
      severity: "MINOR",
      title: "Magic number",
    });
    expect(drafts[0]?.rationale).toContain("2");
  });

  it("ignores a one-off uncited candidate", () => {
    expect(harvestUncited([uncited("Only once")])).toEqual([]);
  });

  it("falls back to a generic id when the title has no word characters", () => {
    expect(harvestUncited([uncited("@@@"), uncited("@@@")])[0]?.id).toBe("unwritten-rule");
  });

  it("harvests only uncited candidates, never malformed or out-of-scope", () => {
    const rejected: RejectedCandidate[] = [
      { reason: "malformed", raw: "x" },
      { reason: "out-of-scope", raw: "y", title: "Scoped", guidelineId: "g" },
      { reason: "out-of-scope", raw: "z", title: "Scoped", guidelineId: "g" },
    ];
    expect(harvestUncited(rejected)).toEqual([]);
  });
});
