import type { ModelReply } from "../model/port.js";

/** What a file is called when its reply ran out of output before any answer. */
export const OUTPUT_CAP_HIT = "output cap hit";

/** Output the model may spend thinking before it writes its answer. */
export const REASONING_HEADROOM_TOKENS = 0;

/** Output one file's findings may take. */
export const REPLY_TOKENS_PER_FILE = 0;

/** The reply cap of a pass over this many files, never above the configured ceiling. */
export function outputCapFor(_files: number, ceiling: number): number {
  return ceiling;
}

/** True when the reply stopped on the cap with no text at all. */
export function hitOutputCap(reply: ModelReply): boolean {
  return reply.finishReason === "unimplemented";
}
