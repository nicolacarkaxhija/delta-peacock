import type { Config } from "../config/schema.js";
import { ToolError } from "../errors.js";
import { createAnthropicPort } from "./anthropic.js";
import type { ModelPort } from "./port.js";

export function buildModelPort(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
): ModelPort {
  if (config.model.id === undefined) {
    throw new ToolError(
      "model.id is required to review; set it in config or DELTA_PEACOCK_MODEL_ID",
    );
  }
  if (config.model.provider === "anthropic") {
    const apiKey = env["ANTHROPIC_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new ToolError("ANTHROPIC_API_KEY is not set; the anthropic provider needs it");
    }
    return createAnthropicPort({ apiKey, modelId: config.model.id });
  }
  throw new ToolError(
    `model provider "${config.model.provider}" is not wired up yet; anthropic is available`,
  );
}
