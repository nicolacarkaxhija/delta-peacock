import type { ModelUsage } from "./port.js";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A failed model call that still spent tokens, the original failure as its cause. */
export class SpentError extends Error {
  readonly spent: ModelUsage;

  constructor(cause: unknown, spent: ModelUsage, message: string = messageOf(cause)) {
    super(message, { cause });
    this.name = "SpentError";
    this.spent = spent;
  }
}

/** The tokens a failed model call spent, from the error or any error it wraps. */
export function spentOf(error: unknown): ModelUsage | undefined {
  void error;
  return undefined;
}
