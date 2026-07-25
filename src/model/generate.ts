import { generateText, stepCountIs, type LanguageModel } from "ai";
import type { ModelReply, ModelRequest } from "./port.js";
import { normalizeUsage } from "./usage.js";

/**
 * The one place a request meets the AI SDK: every adapter delegates here, so
 * tool wiring, bounds and usage mapping cannot drift between providers.
 */
export async function completeWith(
  model: LanguageModel,
  request: ModelRequest,
): Promise<ModelReply> {
  const result = await generateText({
    model,
    system: request.system,
    prompt: request.user,
    // pinned low by default: two fresh reviews of one diff should agree, so the
    // gate outcome does not swing on sampling noise the caller never asked for
    temperature: request.temperature ?? 0,
    ...(request.tools
      ? { tools: request.tools, stopWhen: stepCountIs(request.maxToolRounds ?? 6) }
      : {}),
  });
  const toolCalls = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
  return {
    text: result.text,
    usage: normalizeUsage(result.usage),
    ...(toolCalls > 0 ? { toolCalls } : {}),
  };
}
