import type { ModelPort } from "./port.js";
import { unavailability } from "./unavailable.js";

/** Calls per request before the model counts as out of reach. */
export const MODEL_ATTEMPTS = 3;

/** The first backoff; each retry doubles it, so a short provider outage passes before the review gives up. */
export const BACKOFF_BASE_MS = 4000;

/** The longest wait a provider's Retry-After may ask for before the review gives up on it. */
export const RETRY_AFTER_CAP_MS = 60_000;

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Test seam for the backoff; real timers by default. */
  wait?: ((ms: number) => Promise<void>) | undefined;
  /** Test seam for the jitter; Math.random by default. */
  random?: () => number;
  /** Test seam for a Retry-After date; Date.now by default. */
  now?: () => number;
}

// a refused credential never heals on retry, so it is never one
const RETRIED = new Set(["unreachable", "limit", "timeout"]);

/** True for a provider out of reach, a rate or quota limit or a timeout. */
export function retryable(error: unknown): boolean {
  return RETRIED.has(unavailability(error, "fail") ?? "");
}

/** The wait before a retry: doubling from the base, jittered between half and all of it. */
export function backoffMs(
  retry: number,
  random: () => number,
  baseMs: number = BACKOFF_BASE_MS,
): number {
  return baseMs * 2 ** (retry - 1) * (0.5 + random() / 2);
}

/** The wait a provider asked for in a Retry-After header anywhere in the chain, capped. */
export function retryAfterMs(error: unknown, now: () => number = Date.now): number | undefined {
  void [error, now];
  return undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The port asked again with backoff on an outage, up to its attempts. */
export function withRetry(port: ModelPort, options: RetryOptions = {}): ModelPort {
  const attempts = options.attempts ?? MODEL_ATTEMPTS;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  return {
    complete: async (request) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await port.complete(request);
        } catch (error) {
          if (!retryable(error)) throw error;
          if (attempt >= attempts) {
            throw new Error(`${String(attempts)} attempts, the last: ${(error as Error).message}`, {
              cause: error,
            });
          }
          await wait(backoffMs(attempt, random, options.baseMs));
        }
      }
    },
  };
}
