import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany, type EmbeddingModel } from "ai";
import type { Config } from "../config/schema.js";
import { defaultCounterPath, monthKey, recordSpend } from "../cost/counter.js";
import { ToolError } from "../errors.js";

export interface EmbeddingReply {
  vectors: number[][];
  /** Tokens the provider billed for, when it says. */
  tokens?: number;
}

/** Turns texts into vectors; the rag embeddings backend runs on this port. */
export interface EmbeddingPort {
  embed(texts: readonly string[]): Promise<EmbeddingReply>;
}

async function embedWith(model: EmbeddingModel, texts: readonly string[]): Promise<EmbeddingReply> {
  const result = await embedMany({ model, values: [...texts] });
  const tokens = result.usage.tokens;
  return {
    vectors: result.embeddings,
    // NaN happens when the provider bills nothing; it must not reach spend math
    ...(Number.isFinite(tokens) ? { tokens } : {}),
  };
}

export interface OpenAiishEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}

export function openAiishEmbedding(options: OpenAiishEmbeddingOptions): EmbeddingModel {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return provider.embedding(options.modelId);
}

export interface BedrockEmbeddingOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function bedrockEmbedding(options: BedrockEmbeddingOptions): EmbeddingModel {
  const provider = createAmazonBedrock({
    region: options.region,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
    ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return provider.embedding(options.modelId);
}

function createModel(
  modelId: string,
  rag: Config["context"]["rag"],
  env: Readonly<Record<string, string | undefined>>,
): EmbeddingModel {
  if (rag.provider === "bedrock") {
    const region = env["AWS_REGION"];
    const accessKeyId = env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
    if (region === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
      throw new ToolError(
        "AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for bedrock embeddings",
      );
    }
    return bedrockEmbedding({
      region,
      accessKeyId,
      secretAccessKey,
      ...(env["AWS_SESSION_TOKEN"] !== undefined ? { sessionToken: env["AWS_SESSION_TOKEN"] } : {}),
      ...(rag.baseUrl !== undefined ? { baseUrl: rag.baseUrl } : {}),
      modelId,
    });
  }
  return openAiishEmbedding({
    baseUrl: rag.baseUrl ?? "",
    apiKey: env["OPENAI_API_KEY"] ?? "unused-for-local-hosts",
    modelId,
  });
}

/**
 * Builds the configured embedding adapter, wrapped so every call's billed
 * tokens land on the spend counter at cost.rateEmbedPer1M.
 */
export function buildEmbeddingPort(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
  clock: () => Date = () => new Date(),
): EmbeddingPort {
  const rag = config.context.rag;
  const modelId = rag.model;
  if (modelId === undefined) {
    throw new ToolError("context.rag.model is required for the embeddings backend");
  }
  // eager, so a missing credential is an actionable error before any work
  const model = createModel(modelId, rag, env);
  return priceEmbeddings({ embed: (texts) => embedWith(model, texts) }, config, clock);
}

/** Records every call's billed tokens on the spend counter; free rate passes through. */
export function priceEmbeddings(
  port: EmbeddingPort,
  config: Config,
  clock: () => Date,
): EmbeddingPort {
  if (config.cost.rateEmbedPer1M <= 0) return port;
  return {
    async embed(texts) {
      const reply = await port.embed(texts);
      const tokens = reply.tokens ?? Math.ceil(texts.join("").length / 4);
      const spent = (tokens / 1_000_000) * config.cost.rateEmbedPer1M;
      await recordSpend(config.cost.counterPath ?? defaultCounterPath(), monthKey(clock()), spent);
      return reply;
    },
  };
}

/** Shared cosine similarity for the retrieval ranking. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
