import { describe, expect, it } from "vitest";
import { metered, spendCeiling } from "../src/cost/ceiling.js";
import type { ModelPort, ModelReply } from "../src/model/port.js";
import { ModelUnavailableError } from "../src/model/unavailable.js";

const RATES = {
  rateInputPer1M: 3,
  rateOutputPer1M: 15,
  rateCacheReadPer1M: 0.3,
  rateCacheWritePer1M: 3.75,
};

function answering(reply: ModelReply): { port: ModelPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      complete() {
        calls += 1;
        return Promise.resolve(reply);
      },
    },
  };
}

const PAID: ModelReply = { text: "{}", usage: { inputTokens: 1000, outputTokens: 100 } };

describe("the spend ceiling", () => {
  it("refuses the call after the one that reached the limit", async () => {
    const ceiling = spendCeiling(0.008, RATES);
    const { port, calls } = answering(PAID);
    const guarded = metered(port, ceiling);
    await guarded.complete({ system: "s", user: "u" });
    expect(ceiling.reached()).toBe(false);
    await guarded.complete({ system: "s", user: "u" });
    expect(ceiling.spent()).toBeCloseTo(0.009);
    const refused = guarded.complete({ system: "s", user: "u" });
    await expect(refused).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(refused).rejects.toMatchObject({ why: "cost-cap" });
    expect(calls()).toBe(2);
  });

  it("counts no reply the response cache served", async () => {
    const ceiling = spendCeiling(0.001, RATES);
    const { port } = answering({ ...PAID, cached: true });
    const guarded = metered(port, ceiling);
    await guarded.complete({ system: "s", user: "u" });
    await guarded.complete({ system: "s", user: "u" });
    expect(ceiling.spent()).toBe(0);
  });

  it("never stops a review with no cap", () => {
    const ceiling = spendCeiling(Number.POSITIVE_INFINITY, RATES);
    ceiling.add({ inputTokens: 1e9, outputTokens: 1e9 });
    expect(ceiling.reached()).toBe(false);
  });
});
