import type { ModelReply } from "../model/port.js";

/** What a file is called when its reply ran out of output before any answer. */
export const OUTPUT_CAP_HIT = "output cap hit";

/** Output the model may spend thinking before it writes its answer. */
export const REASONING_HEADROOM_TOKENS = 6000;

/** Output one file's findings may take. */
export const REPLY_TOKENS_PER_FILE = 600;

/** How much more room a reply that ran out of output is given on its one retry. */
export const OUTPUT_CAP_RETRY_FACTOR = 2;

/** The reply cap of a pass over this many files, never above the configured ceiling. */
export function outputCapFor(files: number, ceiling: number): number {
  return Math.min(ceiling, REASONING_HEADROOM_TOKENS + Math.max(files, 1) * REPLY_TOKENS_PER_FILE);
}

/** True when the reply stopped on the cap with no text at all. */
export function hitOutputCap(reply: ModelReply): boolean {
  return reply.finishReason === "length" && reply.text.trim() === "";
}
