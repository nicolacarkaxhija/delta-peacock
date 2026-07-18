import type { ToolSet } from "ai";

export interface ContextInput {
  cwd: string;
  diff: string;
  changedFiles: readonly string[];
}

/**
 * A strategy for giving the model awareness beyond the diff. A provider may
 * inject text into the system prompt, offer on-demand tools, or both.
 */
export interface ContextProvider {
  name: string;
  /**
   * Text for the prompt's project-context block; empty means nothing to
   * inject. Async only when the strategy calls out (embeddings retrieval);
   * callers always await, which is free for the sync majority.
   */
  systemContext(input: ContextInput): string | Promise<string>;
  /** On-demand tools for the agentic strategy; undefined means none. */
  tools?(input: ContextInput): ToolSet;
  /** Notices worth surfacing (cache rebuilds, degradations). */
  notices?(): string[];
}

export const NONE_PROVIDER: ContextProvider = {
  name: "none",
  systemContext: () => "",
};

/**
 * Layers several strategies into one provider. Context sections concatenate
 * in the given order (earlier providers win the shared token budget), tool
 * sets merge, and notices accumulate. The strong combination is repo_map for
 * a cheap always-on map plus agentic for on-demand digging.
 */
export function composeProviders(providers: readonly ContextProvider[]): ContextProvider {
  const withTools = providers.filter((provider) => provider.tools !== undefined);
  return {
    name: providers.map((provider) => provider.name).join("+"),
    systemContext(input: ContextInput): string | Promise<string> {
      const parts = providers.map((provider) => provider.systemContext(input));
      const join = (sections: string[]): string =>
        sections.filter((section) => section !== "").join("\n\n");
      // stay synchronous unless a member actually went async
      return parts.some((part) => typeof part !== "string")
        ? Promise.all(parts.map((part) => Promise.resolve(part))).then(join)
        : join(parts as string[]);
    },
    ...(withTools.length > 0
      ? {
          tools: (input: ContextInput) =>
            Object.fromEntries(
              withTools.flatMap((provider) => Object.entries(provider.tools?.(input) ?? {})),
            ),
        }
      : {}),
    notices() {
      return providers.flatMap((provider) => provider.notices?.() ?? []);
    },
  };
}

/** Rough sizing used everywhere context meets a token budget. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Trims to the budget on line boundaries, never mid-line. */
export function capToTokenBudget(text: string, maxTokens: number): string {
  if (approximateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const cost = approximateTokens(`${line}\n`);
    if (total + cost > maxTokens) break;
    kept.push(line);
    total += cost;
  }
  return kept.join("\n");
}
