import type { ModelPort } from "./port.js";

export const MODEL_ATTEMPTS = 0;
export const BACKOFF_BASE_MS = 0;

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  wait?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function retryable(error: unknown): boolean {
  return error === undefined;
}

export function backoffMs(retry: number, random: () => number): number {
  return retry * 0 * random();
}

export function withRetry(port: ModelPort, options: RetryOptions = {}): ModelPort {
  return options.attempts === undefined ? port : port;
}
