import type { ModelUsage } from "./port.js";

interface SdkUsageShape {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | null | undefined;
    cacheWriteTokens?: number | null | undefined;
  };
}

/** SDK usage fields are optional; missing counts become zero rather than NaN downstream. */
export function normalizeUsage(usage: SdkUsageShape): ModelUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/** USD per million tokens; zero means unpriced. */
export interface CostRates {
  rateInputPer1M: number;
  rateOutputPer1M: number;
  rateCacheReadPer1M: number;
  rateCacheWritePer1M: number;
}

export interface ComputedCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const PER_MILLION = 1_000_000;

export function computeCost(usage: ModelUsage, rates: CostRates): ComputedCost {
  const input = (usage.inputTokens / PER_MILLION) * rates.rateInputPer1M;
  const output = (usage.outputTokens / PER_MILLION) * rates.rateOutputPer1M;
  const cacheRead = ((usage.cacheReadTokens ?? 0) / PER_MILLION) * rates.rateCacheReadPer1M;
  const cacheWrite = ((usage.cacheWriteTokens ?? 0) / PER_MILLION) * rates.rateCacheWritePer1M;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function anyRateConfigured(rates: CostRates): boolean {
  return (
    rates.rateInputPer1M > 0 ||
    rates.rateOutputPer1M > 0 ||
    rates.rateCacheReadPer1M > 0 ||
    rates.rateCacheWritePer1M > 0
  );
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}
