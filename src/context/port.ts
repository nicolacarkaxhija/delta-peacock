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
  /** Text for the prompt's project-context block; empty means nothing to inject. */
  systemContext(input: ContextInput): string;
  /** On-demand tools for the agentic strategy; undefined means none. */
  tools?(input: ContextInput): ToolSet;
  /** Notices worth surfacing (cache rebuilds, degradations). */
  notices?(): string[];
}

export const NONE_PROVIDER: ContextProvider = {
  name: "none",
  systemContext: () => "",
};

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
