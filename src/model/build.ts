import type { Config } from "../config/schema.js";
import { ToolError } from "../errors.js";
import { createAnthropicPort } from "./anthropic.js";
import { createBedrockPort } from "./bedrock.js";
import { createOpenAiishPort } from "./openaiish.js";
import type { ModelPort } from "./port.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  provider: string,
): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ToolError(`${name} is not set; the ${provider} provider needs it`);
  }
  return value;
}

export interface ModelRef {
  provider: "anthropic" | "bedrock" | "openrouter" | "openai-compatible";
  id: string;
  baseUrl?: string | undefined;
}

export function buildModelPort(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
): ModelPort {
  const modelId = config.model.id;
  if (modelId === undefined) {
    throw new ToolError(
      "model.id is required to review; set it in config or DELTA_PEACOCK_MODEL_ID",
    );
  }
  return buildModelPortFor(
    {
      provider: config.model.provider,
      id: modelId,
      ...(config.model.baseUrl !== undefined ? { baseUrl: config.model.baseUrl } : {}),
    },
    env,
  );
}

/** The same wiring for ensemble members and judges: always provider plus model. */
export function buildModelPortFor(
  ref: ModelRef,
  env: Readonly<Record<string, string | undefined>>,
): ModelPort {
  const modelId = ref.id;
  switch (ref.provider) {
    case "anthropic":
      return createAnthropicPort({
        apiKey: requiredEnv(env, "ANTHROPIC_API_KEY", "anthropic"),
        modelId,
      });
    case "openrouter":
      return createOpenAiishPort({
        apiKey: requiredEnv(env, "OPENROUTER_API_KEY", "openrouter"),
        modelId,
        baseUrl: ref.baseUrl ?? OPENROUTER_BASE_URL,
      });
    case "openai-compatible": {
      // the schema's cross-field rules guarantee the base url is present for
      // every openai-compatible ref this function ever receives: config.model,
      // an ensemble member or judge, and the calibration model alike
      const baseUrl = ref.baseUrl ?? "";
      return createOpenAiishPort({
        // many local hosts accept any key; default keeps them zero-config
        apiKey: env["OPENAI_API_KEY"] ?? "unused",
        modelId,
        baseUrl,
      });
    }
    case "bedrock":
      return createBedrockPort({
        region: requiredEnv(env, "AWS_REGION", "bedrock"),
        accessKeyId: requiredEnv(env, "AWS_ACCESS_KEY_ID", "bedrock"),
        secretAccessKey: requiredEnv(env, "AWS_SECRET_ACCESS_KEY", "bedrock"),
        ...(env["AWS_SESSION_TOKEN"] !== undefined && env["AWS_SESSION_TOKEN"] !== ""
          ? { sessionToken: env["AWS_SESSION_TOKEN"] }
          : {}),
        modelId,
        ...(ref.baseUrl !== undefined ? { baseUrl: ref.baseUrl } : {}),
      });
  }
}
