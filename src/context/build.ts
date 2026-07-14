import type { Config } from "../config/schema.js";
import { createAgenticProvider } from "./agentic.js";
import { NONE_PROVIDER, type ContextProvider } from "./port.js";
import { createRagProvider } from "./rag.js";
import { createRepoMapProvider } from "./repo-map.js";

export function buildContextProvider(config: Config): ContextProvider {
  switch (config.context.provider) {
    case "none":
      return NONE_PROVIDER;
    case "repo_map":
      return createRepoMapProvider();
    case "agentic":
      return createAgenticProvider();
    case "rag":
      return createRagProvider();
  }
}
