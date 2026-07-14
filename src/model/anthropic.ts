import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import type { ModelPort, ModelReply, ModelRequest, ModelUsage } from "./port.js";

export interface AnthropicPortOptions {
  apiKey: string;
  modelId: string;
  /** Test seam for the adapter contract test; production uses global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface SdkUsageShape {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | null | undefined;
    cacheWriteTokens?: number | null | undefined;
  };
}

/** SDK usage fields are optional; missing counts become zero rather than NaN downstream. */
export function normalizeUsage(usage: SdkUsageShape): ModelUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
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
        ...(request.tools
          ? { tools: request.tools, stopWhen: stepCountIs(request.maxToolRounds ?? 6) }
          : {}),
      });
      return { text: result.text, usage: normalizeUsage(result.usage) };
    },
  };
}
