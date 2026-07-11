import { describe, expect, it } from "vitest";
import { fingerprintOf, type Violation } from "../src/domain/finding.js";
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
});
