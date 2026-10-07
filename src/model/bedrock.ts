import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { completeWith, type CacheMarker } from "./generate.js";
import type { ModelPort } from "./port.js";

/** Caches the system prompt's stable prefix, the guidelines every batch shares. */
const CACHE: CacheMarker = { bedrock: { cachePoint: { type: "default" } } };

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
  // only Anthropic models take a cache point on Bedrock's system prompt here
  const cache = options.modelId.includes("anthropic.") ? CACHE : undefined;
  return {
    complete: (request) => completeWith(provider(options.modelId), request, cache),
  };
}
