import type { ModelPort, ModelUsage } from "../model/port.js";
import { ModelUnavailableError } from "../model/unavailable.js";
import { computeCost, type CostRates } from "../model/usage.js";

/** The running cost of one review against the most it may spend. */
export interface SpendCeiling {
  /** USD the review may spend; Infinity when no cap applies. */
  readonly limit: number;
  /** USD spent so far, priced from the replies' actual usage. */
  spent(): number;
  add(usage: ModelUsage): void;
  /** True once the running cost reached the limit. */
  reached(): boolean;
}

export function spendCeiling(limit: number, rates: CostRates): SpendCeiling {
  let spent = 0;
  return {
    limit,
    spent: () => spent,
    add(usage) {
      spent += computeCost(usage, rates).total;
    },
    reached: () => spent >= limit,
  };
}

const usd = (amount: number): string => amount.toFixed(4);

/** Why a call was refused, in the words the log and the report give. */
export function ceilingReason(ceiling: SpendCeiling): string {
  return `the running cost ${usd(ceiling.spent())} USD reached the cap of ${usd(ceiling.limit)} USD`;
}

/** Counts every paid reply and refuses the next call once the cap is reached; calls in flight finish. */
export function metered(port: ModelPort, ceiling: SpendCeiling): ModelPort {
  return {
    async complete(request) {
      if (ceiling.reached()) throw new ModelUnavailableError("cost-cap", ceilingReason(ceiling));
      const reply = await port.complete(request);
      if (reply.usage !== undefined && reply.cached !== true) ceiling.add(reply.usage);
      return reply;
    },
  };
}
