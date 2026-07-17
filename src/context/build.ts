import type { Config } from "../config/schema.js";
import { createAgenticProvider } from "./agentic.js";
import { composeProviders, NONE_PROVIDER, type ContextProvider } from "./port.js";
import { createRagProvider } from "./rag.js";
import { createRepoMapProvider } from "./repo-map.js";

type StrategyName = "repo_map" | "agentic" | "rag";

const FACTORIES: Record<StrategyName, () => ContextProvider> = {
  repo_map: createRepoMapProvider,
  agentic: createAgenticProvider,
  rag: createRagProvider,
};

/** The strategies a config activates: providers (layered) wins over provider. */
export function activeStrategies(config: Config): StrategyName[] {
  if (config.context.providers.length > 0) return [...config.context.providers];
  if (config.context.provider === "none") return [];
  return [config.context.provider];
}

export function buildContextProvider(config: Config): ContextProvider {
  const strategies = activeStrategies(config);
  if (strategies.length === 0) return NONE_PROVIDER;
  const providers = strategies.map((name) => FACTORIES[name]());
  const first = providers[0];
  if (providers.length === 1 && first !== undefined) return first;
  return composeProviders(providers);
}
