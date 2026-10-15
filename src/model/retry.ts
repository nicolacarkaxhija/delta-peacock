import type { ModelPort, ModelUsage } from "./port.js";
import { SpentError, spentOf } from "./spent.js";
import { errorChain, unavailability } from "./unavailable.js";
import { addUsage } from "./usage.js";

/** Calls per request before the model counts as out of reach. */
export const MODEL_ATTEMPTS = 3;

/** The first backoff; each retry doubles it, so a short provider outage passes before the review gives up. */
export const BACKOFF_BASE_MS = 4000;

/** The longest wait honoured from a provider's Retry-After. */
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

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** A delay header value in milliseconds, or undefined when it names no wait. */
function delayOf(headers: Record<string, unknown>, now: () => number): number | undefined {
  const ms = headers["retry-after-ms"];
  if (typeof ms === "string" && DECIMAL.test(ms.trim())) return Number(ms);
  const after = headers["retry-after"];
  if (typeof after !== "string") return undefined;
  const delay = DECIMAL.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now();
  return delay >= 0 ? delay : undefined;
}

/** The wait a provider asked for in a Retry-After header anywhere in the chain, capped. */
export function retryAfterMs(error: unknown, now: () => number = Date.now): number | undefined {
  for (const link of errorChain(error)) {
    const raw = link["responseHeaders"];
    if (typeof raw !== "object" || raw === null) continue;
    const headers = Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [name.toLowerCase(), value as unknown]),
    );
    const delay = delayOf(headers, now);
    if (delay !== undefined) return Math.min(delay, RETRY_AFTER_CAP_MS);
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const plus = (a: ModelUsage, b: ModelUsage | undefined): ModelUsage =>
  b === undefined ? a : addUsage(a, b);

/** The port asked again with backoff on an outage, up to its attempts. */
export function withRetry(port: ModelPort, options: RetryOptions = {}): ModelPort {
  const attempts = options.attempts ?? MODEL_ATTEMPTS;
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  return {
    complete: async (request) => {
      // the tokens failed attempts spent, owed by the answer or the final failure
      let spent: ModelUsage | undefined;
      // a retry sends the whole request again, its tool loop included
      for (let attempt = 1; ; attempt += 1) {
        try {
          const reply = await port.complete(request);
          return spent === undefined ? reply : { ...reply, usage: plus(spent, reply.usage) };
        } catch (error) {
          const own = spentOf(error);
          if (!retryable(error)) {
            throw spent === undefined ? error : new SpentError(error, plus(spent, own));
          }
          spent = spent === undefined ? own : plus(spent, own);
          if (attempt >= attempts) {
            const message = `${String(attempts)} attempts, the last: ${(error as Error).message}`;
            throw spent === undefined
              ? new Error(message, { cause: error })
              : new SpentError(error, spent, message);
          }
          await wait(retryAfterMs(error, now) ?? backoffMs(attempt, random, options.baseMs));
        }
      }
    },
  };
}
