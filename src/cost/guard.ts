import type { Config } from "../config/schema.js";
import { approximateTokens } from "../context/port.js";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelRequest } from "../model/port.js";
import { anyRateConfigured, computeCost } from "../model/usage.js";
import { costExplorerMonthToDate, type CostExplorerSend } from "./cost-explorer.js";
import { defaultCounterPath, monthKey, readMonthSpend } from "./counter.js";

/**
 * The response we have not paid for yet, priced at the reply's hard ceiling so
 * the estimate is an upper bound rather than a guess (see the model port).
 */
export const ESTIMATED_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

export interface BudgetDecision {
  /** Whether the review may proceed. */
  allowed: boolean;
  estimated: number;
  monthToDate?: number;
  reasons: string[];
  notices: string[];
}

export function guardActive(config: Config): boolean {
  return config.cost.maxPerReview > 0 || config.cost.monthlyCap > 0;
}

export function modelCallCount(config: Config): number {
  const calibration = config.calibration.enabled ? 1 : 0;
  if (!config.ensemble.enabled) return 1 + calibration;
  return config.ensemble.members.length + (config.ensemble.mode === "judge" ? 1 : 0) + calibration;
}

export async function checkBudget(
  config: Config,
  request: ModelRequest,
  now: Date,
  costExplorerSend?: CostExplorerSend,
): Promise<BudgetDecision> {
  const notices: string[] = [];
  const reasons: string[] = [];

  if (!anyRateConfigured(config.cost)) {
    notices.push(
      "cost caps are set but no rates are configured; the estimate is zero and the caps cannot bite",
    );
  }
  const perCall = computeCost(
    {
      inputTokens: approximateTokens(`${request.system}\n${request.user}`),
      outputTokens: ESTIMATED_OUTPUT_TOKENS,
    },
    config.cost,
  ).total;
  const estimated = perCall * modelCallCount(config);

  if (config.cost.maxPerReview > 0 && estimated > config.cost.maxPerReview) {
    reasons.push(
      `estimated cost ${estimated.toFixed(4)} USD exceeds cost.maxPerReview ${config.cost.maxPerReview.toFixed(4)} USD`,
    );
  }

  let monthToDate: number | undefined;
  if (config.cost.monthlyCap > 0) {
    const counterPath = config.cost.counterPath ?? defaultCounterPath();
    if (config.cost.spendSource === "aws-cost-explorer") {
      try {
        monthToDate = await costExplorerMonthToDate(now, costExplorerSend);
      } catch (error) {
        notices.push(
          `cost explorer unavailable (${(error as Error).message}); using the local counter`,
        );
      }
    }
    monthToDate ??= readMonthSpend(counterPath, monthKey(now));
    if (monthToDate + estimated > config.cost.monthlyCap) {
      reasons.push(
        `month-to-date ${monthToDate.toFixed(4)} USD plus the estimate exceeds cost.monthlyCap ${config.cost.monthlyCap.toFixed(4)} USD`,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    estimated,
    ...(monthToDate !== undefined ? { monthToDate } : {}),
    reasons,
    notices,
  };
}
