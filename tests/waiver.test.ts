import { describe, expect, it } from "vitest";
import { findWaiver, parseWaivers, type Waiver } from "../src/review/waiver.js";

function lineMap(
  entries: Record<string, Record<number, string>>,
): Map<string, Map<number, string>> {
  return new Map(
    Object.entries(entries).map(([file, lines]) => [
      file,
      new Map(Object.entries(lines).map(([n, text]) => [Number(n), text])),
    ]),
  );
}

describe("parseWaivers", () => {
  it("parses a trailing waiver directive with its id, reason, and line", () => {
    const { waivers, malformed } = parseWaivers(
      lineMap({
        "src/legacy.js": {
          5: "  console.log(x) // delta-peacock:allow no-console — vendor shim, JIRA-123",
        },
      }),
    );
    expect(malformed).toBe(0);
    expect(waivers).toHaveLength(1);
    expect(waivers[0]).toMatchObject({
      guidelineId: "no-console",
      file: "src/legacy.js",
      line: 5,
      reason: "vendor shim, JIRA-123",
    });
  });

  it("counts a directive with no reason as malformed and drops it", () => {
    const { waivers, malformed } = parseWaivers(
      lineMap({ "a.js": { 1: "x // delta-peacock:allow no-console" } }),
    );
    expect(malformed).toBe(1);
    expect(waivers).toHaveLength(0);
  });

  it("captures an until= date without folding it into the reason", () => {
    const { waivers } = parseWaivers(
      lineMap({
        "a.js": { 1: "x // delta-peacock:allow no-console — vendor shim until=2026-12-31" },
      }),
    );
    expect(waivers[0]?.reason).toBe("vendor shim");
    expect(waivers[0]?.until).toBe("2026-12-31");
  });

  it("parses a #-comment directive and a -- separator", () => {
    const { waivers } = parseWaivers(
      lineMap({ "s.py": { 3: "x = 1  # delta-peacock:allow no-print -- debugging only" } }),
    );
    expect(waivers[0]).toMatchObject({
      guidelineId: "no-print",
      reason: "debugging only",
      line: 3,
    });
  });

  it("ignores ordinary lines that carry no directive", () => {
    const { waivers, malformed } = parseWaivers(
      lineMap({ "a.js": { 1: "const x = 1;", 2: "return compute(x);" } }),
    );
    expect(waivers).toHaveLength(0);
    expect(malformed).toBe(0);
  });
});

describe("findWaiver", () => {
  const waiver: Waiver = { guidelineId: "no-console", file: "a.js", line: 5, reason: "x" };

  it("matches a finding on the waiver's own line by id and file", () => {
    expect(findWaiver({ guidelineId: "no-console", file: "a.js", line: 5 }, [waiver])?.reason).toBe(
      "x",
    );
  });

  it("matches a finding on the line below the waiver (next-line comment)", () => {
    expect(findWaiver({ guidelineId: "no-console", file: "a.js", line: 6 }, [waiver])).toBe(waiver);
  });

  it("does not match a different id, a different file, or an uncited finding", () => {
    expect(findWaiver({ guidelineId: "other", file: "a.js", line: 5 }, [waiver])).toBeUndefined();
    expect(
      findWaiver({ guidelineId: "no-console", file: "b.js", line: 5 }, [waiver]),
    ).toBeUndefined();
    expect(findWaiver({ file: "a.js", line: 5 }, [waiver])).toBeUndefined();
  });
});
