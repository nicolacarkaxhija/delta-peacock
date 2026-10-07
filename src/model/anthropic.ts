import { createAnthropic } from "@ai-sdk/anthropic";
import { completeWith, type CacheMarker } from "./generate.js";
import type { ModelPort } from "./port.js";

/** Caches the system prompt's stable prefix, the guidelines every batch shares. */
const CACHE: CacheMarker = { anthropic: { cacheControl: { type: "ephemeral" } } };

export { normalizeUsage } from "./usage.js";

export interface AnthropicPortOptions {
  apiKey: string;
  modelId: string;
  /** Test seam for the adapter contract test; production uses global fetch. */
  fetch?: typeof globalThis.fetch;
}

export function createAnthropicPort(options: AnthropicPortOptions): ModelPort {
  const provider = createAnthropic({
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    complete: (request) => completeWith(provider(options.modelId), request, CACHE),
  };
}
