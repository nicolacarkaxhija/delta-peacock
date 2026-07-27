import { approximateTokens } from "../context/port.js";
import { changedFilesFromDiff } from "../git/diff.js";

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

export interface BatchPlan {
  /** Each entry is one model call's worth of diff. */
  diffBatches: string[];
  /** The context text resolved for each entry of diffBatches, "" where dropped. */
  batchContexts: string[];
  /** At least one batch could not afford its context; batching alone is not degradation. */
  degraded: boolean;
  notices: string[];
}

/**
 * Once the whole diff cannot fit even without context, packs it into batches
 * sized to leave room for the stable prefix and the context budget in every
 * one of them, so splitting the diff is not, by itself, a reason to give up
 * cross-file context: agentic/repo_map/rag are not abandoned just because
 * *something* had to be batched. Greedy bin packing over per-file chunks -- a
 * file joins the running batch while prefix + context + batch still fit the
 * window; the next file that would tip it over starts a new batch instead.
 * Only a file whose own diff cannot afford context even alone loses it, named
 * in a notice, and it does so by itself rather than dragging a whole batch of
 * unrelated files down with it.
 */
export function planBatches(
  whole: BudgetPlan,
  diff: string,
  projectContext: string,
  prefix: string,
  windowTokens: number,
): BatchPlan {
  if (!whole.batchDiff) {
    return {
      diffBatches: [diff],
      batchContexts: [whole.dropContext ? "" : projectContext],
      degraded: whole.dropContext,
      notices: [],
    };
  }
  // the packing cap leaves room for what every batch must also carry, so a
  // batch built up to this cap already fits the window with context intact
  const reserved = approximateTokens(prefix) + approximateTokens(projectContext);
  const diffBatches = splitDiffByFile(diff, windowTokens - reserved);
  const notices: string[] = [];
  let degraded = false;
  const batchContexts = diffBatches.map((batchDiff, index) => {
    const batchPlan = planBudget({
      prefix,
      context: projectContext,
      diff: batchDiff,
      windowTokens,
    });
    if (!batchPlan.dropContext) return projectContext;
    degraded = true;
    // packing already keeps every affordable file out of this batch, so in
    // every realistic case this names one oversized file, never a roll call
    // of the whole batch
    const files = changedFilesFromDiff(batchDiff).join(", ") || "unnamed files";
    notices.push(
      `budget: batch ${String(index + 1)}/${String(diffBatches.length)} (${files}) does not fit the window with cross-file context; reviewing it without context`,
    );
    return "";
  });
  return { diffBatches, batchContexts, degraded, notices };
}
