import type { ToolSet } from "ai";
import type { Credentials } from "../config/credentials.js";
import type { Config } from "../config/schema.js";
import type { ModelRequest } from "../model/port.js";
import { createAgenticProvider } from "./agentic.js";
import { buildEmbeddingPort, type EmbeddingPort } from "./embedding.js";
import {
  capToTokenBudget,
  composeProviders,
  NONE_PROVIDER,
  type ContextInput,
  type ContextProvider,
} from "./port.js";
import { createRagEmbeddingsProvider, createRagProvider } from "./rag.js";
import { createRepoMapProvider } from "./repo-map.js";
import { createScopeProvider } from "./scope.js";
import { createFullFilesProvider } from "./full-files.js";

type StrategyName = "repo_map" | "agentic" | "rag" | "scope" | "full_files";

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
    scope: createScopeProvider,
    full_files: () => createFullFilesProvider({ maxTokens: config.context.maxTokens }),
  };
  const providers = strategies.map((name) => factories[name]());
  const first = providers[0];
  if (providers.length === 1 && first !== undefined) return first;
  return composeProviders(providers);
}

export interface ResolvedContext {
  /** Text for the prompt's project-context block; "" means nothing to inject. */
  projectContext: string;
  /** On-demand tools the request should carry; undefined means the strategy offers none. */
  tools: ToolSet | undefined;
  /** Notices the provider raised while resolving (cache rebuilds, degradations). */
  notices: string[];
}

/**
 * Builds the configured provider and resolves it against one input in a
 * single call. Every caller that hands the model a request — review, ask,
 * bench — needs this same triple (context text, tools, notices); each one
 * used to assemble it by hand, which is how bench fell out of step with
 * production: it read systemContext but never called tools, so an agentic
 * bench run silently sent the model no tool access at all (a review or ask
 * run under the same config attached both). Routing every caller through
 * this one function is what makes that divergence structurally impossible.
 */
export async function resolveContext(
  config: Config,
  deps: ContextBuildDeps,
  input: ContextInput,
): Promise<ResolvedContext> {
  const provider = buildContextProvider(config, deps);
  const projectContext = capToTokenBudget(
    await provider.systemContext(input),
    config.context.maxTokens,
  );
  return {
    projectContext,
    tools: provider.tools?.(input),
    notices: provider.notices?.() ?? [],
  };
}

/**
 * Attaches on-demand context tools to a request exactly as every caller must:
 * both fields together, or neither. `tools` alone without `maxToolRounds`
 * (or vice versa) is not a state any caller should be able to reach.
 */
export function attachContextTools(
  request: ModelRequest,
  tools: ToolSet | undefined,
  maxToolRounds: number,
): ModelRequest {
  return {
    ...request,
    ...(tools !== undefined ? { tools, maxToolRounds } : {}),
  };
}
