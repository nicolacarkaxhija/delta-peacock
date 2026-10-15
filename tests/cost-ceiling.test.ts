import { describe, expect, it } from "vitest";
import { metered, spendCeiling } from "../src/cost/ceiling.js";
import type { ModelPort, ModelReply } from "../src/model/port.js";
import { withRetry } from "../src/model/retry.js";
import { SpentError } from "../src/model/spent.js";
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

describe("a failed call that spent tokens", () => {
  const spent = { inputTokens: 1000, outputTokens: 100 };
  const failing = (error: Error): ModelPort => ({ complete: () => Promise.reject(error) });

  it("counts toward the cap and rethrows the failure untouched", async () => {
    const failure = new SpentError(new Error("overloaded"), spent);
    const ceiling = spendCeiling(0.004, RATES);
    const guarded = metered(failing(failure), ceiling);
    await expect(guarded.complete({ system: "s", user: "u" })).rejects.toBe(failure);
    expect(ceiling.spent()).toBeCloseTo(0.0045, 6);
    await expect(guarded.complete({ system: "s", user: "u" })).rejects.toMatchObject({
      why: "cost-cap",
    });
  });

  it("prices at the call's own rates when it brings them", async () => {
    const ceiling = spendCeiling(1, RATES);
    const guarded = metered(failing(new SpentError(new Error("x"), spent)), ceiling, {
      ...RATES,
      rateInputPer1M: 6,
    });
    await expect(guarded.complete({ system: "s", user: "u" })).rejects.toThrow("x");
    expect(ceiling.spent()).toBeCloseTo(0.0075, 6);
  });

  it("adds nothing when the failure spent no tokens", async () => {
    const ceiling = spendCeiling(1, RATES);
    await expect(
      metered(failing(new Error("x")), ceiling).complete({ system: "s", user: "u" }),
    ).rejects.toThrow("x");
    expect(ceiling.spent()).toBe(0);
  });

  it("counts every failed attempt behind the retry once, with the answer", async () => {
    let call = 0;
    const port: ModelPort = {
      complete: () => {
        call += 1;
        return call === 1
          ? Promise.reject(
              new SpentError(Object.assign(new Error("down"), { statusCode: 503 }), spent),
            )
          : Promise.resolve(PAID);
      },
    };
    const ceiling = spendCeiling(1, RATES);
    const wait = (): Promise<void> => Promise.resolve();
    await metered(withRetry(port, { wait }), ceiling).complete({ system: "s", user: "u" });
    expect(ceiling.spent()).toBeCloseTo(0.009, 6);
  });
});
