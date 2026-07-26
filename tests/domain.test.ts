import { describe, expect, it } from "vitest";
import { fingerprintOf, type Observation, type Violation } from "../src/domain/finding.js";
import { evaluateGate } from "../src/domain/gate.js";
import { meetsThreshold } from "../src/domain/severity.js";

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    kind: "violation",
    guidelineId: "no-console",
    severity: "MAJOR",
    file: "src/app.js",
    line: 3,
    title: "Console statement",
    body: "Remove the console call.",
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    kind: "observation",
    severity: "MINOR",
    file: "src/app.js",
    line: 3,
    title: "Magic number",
    body: "Extract a constant.",
    ...overrides,
  };
}

describe("severity thresholds", () => {
  it.each([
    { severity: "BLOCKER", threshold: "MAJOR", trips: true },
    { severity: "MAJOR", threshold: "MAJOR", trips: true },
    { severity: "MINOR", threshold: "MAJOR", trips: false },
    { severity: "INFO", threshold: "INFO", trips: true },
    { severity: "BLOCKER", threshold: "none", trips: false },
  ] as const)("$severity against $threshold -> $trips", ({ severity, threshold, trips }) => {
    expect(meetsThreshold(severity, threshold)).toBe(trips);
  });
});

describe("gate", () => {
  it("stays open in advisory posture regardless of findings", () => {
    const decision = evaluateGate([violation({ severity: "BLOCKER" })], "none");
    expect(decision.failed).toBe(false);
    expect(decision.failing).toBe(0);
  });

  it("fails when any finding meets the threshold and counts them", () => {
    const decision = evaluateGate(
      [violation({ severity: "BLOCKER" }), violation({ severity: "INFO" })],
      "CRITICAL",
    );
    expect(decision.failed).toBe(true);
    expect(decision.failing).toBe(1);
  });
});

describe("fingerprint", () => {
  it("is stable for the same finding and differs across findings", () => {
    expect(fingerprintOf(violation())).toBe(fingerprintOf(violation()));
    expect(fingerprintOf(violation())).not.toBe(fingerprintOf(violation({ line: 4 })));
    expect(fingerprintOf(violation())).not.toBe(
      fingerprintOf(violation({ guidelineId: "no-eval" })),
    );
  });

  it("keeps a violation's guidelineId-based key unchanged by its title", () => {
    expect(fingerprintOf(violation({ title: "Any title at all" }))).toBe(
      fingerprintOf(violation({ title: "A totally different title" })),
    );
  });

  it("fingerprints an observation from file + line + kind, ignoring freeform title", () => {
    expect(fingerprintOf(observation({ title: "First phrasing of the same problem" }))).toBe(
      fingerprintOf(observation({ title: "Completely different phrasing" })),
    );
  });

  it("still varies an observation's fingerprint by file or line", () => {
    expect(fingerprintOf(observation())).not.toBe(fingerprintOf(observation({ line: 4 })));
    expect(fingerprintOf(observation())).not.toBe(
      fingerprintOf(observation({ file: "src/other.js" })),
    );
  });

  it("never collides a violation and an observation at the same file and line", () => {
    expect(fingerprintOf(violation({ line: 1 }))).not.toBe(fingerprintOf(observation({ line: 1 })));
  });
});
