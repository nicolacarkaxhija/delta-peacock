import { createAnthropic } from "@ai-sdk/anthropic";
import { completeWith } from "./generate.js";
import type { ModelPort } from "./port.js";

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
    complete: (request) => completeWith(provider(options.modelId), request),
  };
}
