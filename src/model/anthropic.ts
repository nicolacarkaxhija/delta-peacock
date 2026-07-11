import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { ModelPort, ModelReply, ModelRequest, ModelUsage } from "./port.js";

/** SDK usage fields are optional; missing counts become zero rather than NaN downstream. */
export function normalizeUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): ModelUsage {
  return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}

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
    async complete(request: ModelRequest): Promise<ModelReply> {
      const result = await generateText({
        model: provider(options.modelId),
        system: request.system,
        prompt: request.user,
      });
      return { text: result.text, usage: normalizeUsage(result.usage) };
    },
  };
}
