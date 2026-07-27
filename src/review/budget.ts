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
 * budget and, when given, never exceed a file-count cap either -- never
 * splitting one file. A single file over either cap still rides alone.
 */
export function splitDiffByFile(
  diff: string,
  maxTokensPerBatch: number,
  maxFilesPerBatch = Number.POSITIVE_INFINITY,
): string[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk !== "");
  const batches: string[] = [];
  let current = "";
  let currentFiles = 0;
  for (const chunk of chunks) {
    const overTokens = current !== "" && approximateTokens(current + chunk) > maxTokensPerBatch;
    const overFiles = current !== "" && currentFiles + 1 > maxFilesPerBatch;
    if (overTokens || overFiles) {
      batches.push(current);
      current = "";
      currentFiles = 0;
    }
    current += chunk;
    currentFiles += 1;
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
 * Caps a single batch well below the token window. Model attention to any one
 * file degrades with how many other files share its batch, long before the
 * window itself binds -- a 439-file diff fits a 100k window as one batch, but
 * a model reviewing it that way misses violations it catches every time when
 * the same file is reviewed alone. Fitting the window is necessary but not
 * sufficient, so every batch answers to this cap too.
 */
export interface AttentionBudget {
  /** A batch never holds more files than this, however much room remains. */
  maxFiles: number;
  /** A batch never holds more (approximate) tokens than this, either. */
  maxTokens: number;
}

/**
 * Once the whole diff cannot fit even without context, or would exceed the
 * attention budget even though it fits the window, packs it into batches
 * sized to leave room for the stable prefix and the context budget in every
 * one of them, so splitting the diff is not, by itself, a reason to give up
 * cross-file context: agentic/repo_map/rag are not abandoned just because
 * *something* had to be batched. Greedy bin packing over per-file chunks -- a
 * file joins the running batch while prefix + context + batch still fit the
 * window AND the batch still fits the attention budget; the next file that
 * would tip either over starts a new batch instead. Only a file whose own
 * diff cannot afford context even alone loses it, named in a notice, and it
 * does so by itself rather than dragging a whole batch of unrelated files
 * down with it.
 */
export function planBatches(
  whole: BudgetPlan,
  diff: string,
  projectContext: string,
  prefix: string,
  windowTokens: number,
  attentionBudget: AttentionBudget,
): BatchPlan {
  const changedFiles = changedFilesFromDiff(diff);
  // the window can easily hold a diff that still has far too many files (or
  // raw tokens) for one call's worth of model attention; either cap alone is
  // reason enough to batch, whether or not the window ever binds
  const attentionBinds =
    changedFiles.length > attentionBudget.maxFiles ||
    approximateTokens(diff) > attentionBudget.maxTokens;

  if (!whole.batchDiff && !attentionBinds) {
    return {
      diffBatches: [diff],
      batchContexts: [whole.dropContext ? "" : projectContext],
      degraded: whole.dropContext,
      notices: [],
    };
  }

  const notices: string[] = [];
  if (!whole.batchDiff && attentionBinds) {
    // the window had nothing to do with this split; say so, or the batch
    // count looks arbitrary next to a window that clearly had room to spare
    notices.push(
      `budget: ${String(changedFiles.length)} file(s) (~${String(approximateTokens(diff))} tokens) exceed the attention budget (max ${String(attentionBudget.maxFiles)} files / ${String(attentionBudget.maxTokens)} tokens per batch); splitting so per-file review quality does not degrade`,
    );
  }
  // the packing cap leaves room for what every batch must also carry, so a
  // batch built up to this cap already fits the window with context intact;
  // the attention cap can bind first, well below the window, capping batches
  // smaller than the window alone would ever require
  const reserved = approximateTokens(prefix) + approximateTokens(projectContext);
  const perBatchTokenCap = Math.min(windowTokens - reserved, attentionBudget.maxTokens);
  const diffBatches = splitDiffByFile(diff, perBatchTokenCap, attentionBudget.maxFiles);
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
