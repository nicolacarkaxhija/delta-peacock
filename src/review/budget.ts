import { approximateTokens } from "../context/port.js";

export interface BudgetInput {
  /** The stable prefix: system instructions plus the guidelines block. */
  prefix: string;
  /** Cross-file context injected after the guidelines. */
  context: string;
  /** The diff under review. */
  diff: string;
  /** The target window the assembled prompt should fit inside. */
  windowTokens: number;
}

export interface BudgetPlan {
  /** Drop the context section to reclaim its tokens. */
  dropContext: boolean;
  /** Split the diff into file-boundary batches reviewed separately. */
  batchDiff: boolean;
  notices: string[];
  /** What the report records about the degradation. */
  estimatedTokens: number;
}

/**
 * One place decides whether an assembled prompt fits the window, and how to
 * degrade when it does not: shed context first, then split the diff into
 * file-boundary batches. Guidelines are never touched; they are the contract.
 */
export function planBudget(input: BudgetInput): BudgetPlan {
  const prefixTokens = approximateTokens(input.prefix);
  const contextTokens = approximateTokens(input.context);
  const diffTokens = approximateTokens(input.diff);
  const full = prefixTokens + contextTokens + diffTokens;
  if (full <= input.windowTokens) {
    return { dropContext: false, batchDiff: false, notices: [], estimatedTokens: full };
  }

  const notices: string[] = [];
  const withoutContext = prefixTokens + diffTokens;
  if (withoutContext <= input.windowTokens) {
    notices.push(
      `prompt (~${String(full)} tokens) exceeds the window (${String(input.windowTokens)}); dropping cross-file context`,
    );
    return { dropContext: true, batchDiff: false, notices, estimatedTokens: withoutContext };
  }

  notices.push(
    `prompt (~${String(full)} tokens) exceeds the window (${String(input.windowTokens)}) even without context; splitting the diff into file-boundary batches`,
  );
  return { dropContext: true, batchDiff: true, notices, estimatedTokens: withoutContext };
}

/**
 * Groups a unified diff's per-file chunks into batches that each fit the token
 * budget, never splitting one file. A single file over budget rides alone.
 */
export function splitDiffByFile(diff: string, maxTokensPerBatch: number): string[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk !== "");
  const batches: string[] = [];
  let current = "";
  for (const chunk of chunks) {
    if (current !== "" && approximateTokens(current + chunk) > maxTokensPerBatch) {
      batches.push(current);
      current = "";
    }
    current += chunk;
  }
  if (current !== "") batches.push(current);
  return batches.length === 0 ? [diff] : batches;
}
