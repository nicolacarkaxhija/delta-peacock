import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { generateText, stepCountIs } from "ai";
import { normalizeUsage } from "./anthropic.js";
import type { ModelPort, ModelReply, ModelRequest } from "./port.js";

export interface BedrockPortOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId: string;
  /** Test seam; also useful for VPC endpoints. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function createBedrockPort(options: BedrockPortOptions): ModelPort {
  const provider = createAmazonBedrock({
    region: options.region,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
    ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
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
