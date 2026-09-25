import { appendFileSync } from "node:fs";
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelReply, type ModelRequest } from "./port.js";
import { normalizeUsage } from "./usage.js";

/** Told to the model on the step after its last tool round. */
export const FINAL_STEP =
  "The tool budget is spent. Do not ask for more context: give your final answer now, in the format requested above.";

interface DumpedStep {
  text: string;
  finishReason: string;
  toolCalls: readonly { toolName: string }[];
}

/** DELTA_PEACOCK_DUMP_REPLY=<file> appends every raw model reply, step by step, as one JSON line. */
function dumpReply(result: { finishReason: string; steps: readonly DumpedStep[] }): void {
  const target = process.env["DELTA_PEACOCK_DUMP_REPLY"];
  if (target === undefined || target === "") return;
  const line = {
    finishReason: result.finishReason,
    steps: result.steps.map((step) => ({
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => call.toolName),
      text: step.text,
    })),
  };
  appendFileSync(target, `${JSON.stringify(line)}\n`);
}

/**
 * The one place a request meets the AI SDK: every adapter delegates here, so
 * tool wiring, bounds and usage mapping cannot drift between providers.
 */
export async function completeWith(
  model: LanguageModel,
  request: ModelRequest,
): Promise<ModelReply> {
  const rounds = request.maxToolRounds ?? 6;
  const result = await generateText({
    model,
    system: request.system,
    prompt: request.user,
    // pinned low by default: two fresh reviews of one diff should agree, so the
    // gate outcome does not swing on sampling noise the caller never asked for
    temperature: request.temperature ?? 0,
    // bound the reply so runaway output cannot outrun the cost estimate
    maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(request.tools
      ? {
          tools: request.tools,
          // the tool rounds, then one answering step with tools switched off
          stopWhen: stepCountIs(rounds + 1),
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            stepNumber >= rounds
              ? { toolChoice: "none" as const, system: `${request.system}\n\n${FINAL_STEP}` }
              : undefined,
        }
      : {}),
  });
  const toolCalls = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
  dumpReply(result);
  return {
    // an empty last step still leaves any answer an earlier step wrote
    text:
      result.text.trim() !== "" ? result.text : result.steps.map((step) => step.text).join("\n"),
    usage: normalizeUsage(result.usage),
    ...(toolCalls > 0 ? { toolCalls } : {}),
  };
}
