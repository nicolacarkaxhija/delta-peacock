import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { normalizeUsage } from "./anthropic.js";
import type { ModelPort, ModelReply, ModelRequest } from "./port.js";

/**
 * One adapter covers OpenRouter and every OpenAI-compatible host (OpenAI
 * itself, Azure, Ollama, vLLM, LM Studio): they all speak the same protocol.
 */
export interface OpenAiishPortOptions {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createOpenAiishPort(options: OpenAiishPortOptions): ModelPort {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    async complete(request: ModelRequest): Promise<ModelReply> {
      const result = await generateText({
        model: provider.chat(options.modelId),
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
