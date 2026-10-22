import { createOpenAI } from "@ai-sdk/openai";
import { omitsTemperature, completeWith } from "./generate.js";
import type { ModelPort } from "./port.js";

/**
 * One adapter covers OpenRouter and every OpenAI-compatible host (OpenAI
 * itself, Azure, Ollama, vLLM, LM Studio): they all speak the same protocol.
 */
export interface OpenAiishPortOptions {
  apiKey: string;
  modelId: string;
  /** Model id fragments that must not receive a temperature; defaults to the built-in list. */
  omitTemperatureFor?: readonly string[];
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
    complete: (request) =>
      completeWith(
        provider.chat(options.modelId),
        request,
        undefined,
        omitsTemperature(options.modelId, options.omitTemperatureFor),
      ),
  };
}
