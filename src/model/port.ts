import type { ToolSet } from "ai";

/**
 * Default ceiling on a reply's length. The cost guard prices this same number
 * as its output stand-in, so the pre-flight estimate is a real upper bound on
 * output rather than a guess: cost, truncation risk and the estimate agree.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

export interface ModelRequest {
  system: string;
  user: string;
  /** On-demand context tools (agentic strategy); adapters run the loop. */
  tools?: ToolSet;
  /** Bound on tool rounds before the model must conclude. */
  maxToolRounds?: number;
  /** Sampling temperature; defaults to 0 so a fresh review is reproducible. */
  temperature?: number;
  /** Ceiling on reply length; defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS}. */
  maxOutputTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelReply {
  text: string;
  usage?: ModelUsage;
  /** How many context-tool invocations the model made while answering. */
  toolCalls?: number;
  /** Served from the response cache; no model was called. */
  cached?: boolean;
  /** The tool results the model saw, as text, for a follow-up call without tools. */
  transcript?: string;
}

/** The primary test seam: everything on our side of it runs real in tests. */
export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelReply>;
}
