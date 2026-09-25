import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { spendLine } from "../src/review/run-review.js";

const now = new Date("2026-09-25T10:00:00Z");

describe("the spend line of a review", () => {
  it("records the spend and prints tokens, cost and the month on the counter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-spend-"));
    const counter = path.join(dir, "spend.json");
    const config = loadConfig({
      root: dir,
      flags: {
        "cost.rateInputPer1M": "1",
        "cost.rateOutputPer1M": "5",
        "cost.monthlyCap": "60",
        "cost.counterPath": counter,
      },
    });
    const usage = { inputTokens: 66695, outputTokens: 1645 };
    expect(await spendLine(config, usage, now)).toBe(
      `cost: 66695 tokens in, 1645 out, 0.0749 USD; 2026-09 spend 0.0749 USD of 60 on ${counter}`,
    );
    expect(await spendLine(config, usage, now)).toContain("2026-09 spend 0.1498 USD of 60");
    const recorded = JSON.parse(readFileSync(counter, "utf8")) as Record<string, number>;
    expect(Object.keys(recorded)).toEqual(["2026-09"]);
  });

  it("leaves out the cap when none is set", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-spend-"));
    const config = loadConfig({
      root: dir,
      flags: { "cost.rateInputPer1M": "1", "cost.counterPath": path.join(dir, "s.json") },
    });
    expect(await spendLine(config, { inputTokens: 1000, outputTokens: 0 }, now)).toMatch(
      /^cost: 1000 tokens in, 0 out, 0\.0010 USD; 2026-09 spend 0\.0010 USD on /,
    );
  });

  it("says the tokens and that nothing prices them when no rate is set", async () => {
    const config = loadConfig({ root: mkdtempSync(path.join(tmpdir(), "dp-spend-")) });
    expect(await spendLine(config, { inputTokens: 5, outputTokens: 2 }, now)).toBe(
      "usage: 5 tokens in, 2 out; no cost rates configured",
    );
  });
});
