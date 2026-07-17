import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { completeWith } from "./generate.js";
import type { ModelPort } from "./port.js";

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
    complete: (request) => completeWith(provider(options.modelId), request),
  };
}
