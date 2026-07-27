import type { Credentials } from "../config/credentials.js";
import type { Config } from "../config/schema.js";
import { createAgenticProvider } from "./agentic.js";
import { buildEmbeddingPort, type EmbeddingPort } from "./embedding.js";
import { composeProviders, NONE_PROVIDER, type ContextProvider } from "./port.js";
import { createRagEmbeddingsProvider, createRagProvider } from "./rag.js";
import { createRepoMapProvider } from "./repo-map.js";

type StrategyName = "repo_map" | "agentic" | "rag";

export interface ContextBuildDeps {
  credentials?: Credentials;
  /** Test seam for the embeddings backend; real adapters otherwise. */
  embeddingPort?: EmbeddingPort;
  clock?: () => Date;
}

/** The strategies a config activates: providers (layered) wins over provider. */
export function activeStrategies(config: Config): StrategyName[] {
  if (config.context.providers.length > 0) return [...config.context.providers];
  if (config.context.provider === "none") return [];
  return [config.context.provider];
}

function buildRag(config: Config, deps: ContextBuildDeps): ContextProvider {
  if (config.context.rag.backend !== "embeddings") return createRagProvider();
  const port =
    deps.embeddingPort ??
    buildEmbeddingPort(config, deps.credentials ?? {}, deps.clock ?? (() => new Date()));
  return createRagEmbeddingsProvider({
    port,
    // model is schema-guaranteed for the embeddings backend
    embeddingKey: `${config.context.rag.provider}/${String(config.context.rag.model)}`,
  });
}

export function buildContextProvider(config: Config, deps: ContextBuildDeps = {}): ContextProvider {
  const strategies = activeStrategies(config);
  if (strategies.length === 0) return NONE_PROVIDER;
  const factories: Record<StrategyName, () => ContextProvider> = {
    repo_map: createRepoMapProvider,
    agentic: createAgenticProvider,
    rag: () => buildRag(config, deps),
  };
  const providers = strategies.map((name) => factories[name]());
  const first = providers[0];
  if (providers.length === 1 && first !== undefined) return first;
  return composeProviders(providers);
}
