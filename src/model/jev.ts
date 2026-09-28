import { z } from "zod";
import type { ModelUsage } from "./port.js";

/** TypeSafe's typed-decision endpoint; every Jev model answers here. */
export const JEV_BASE_URL = "https://api.typesafe.ai";

/** USD per million input tokens for Jev 1.13; output tokens are free. */
export const JEV_RATE_INPUT_PER_1M = 0.042;

/** One option set the model picks from; a null description needs no rubric. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

export interface JevRequest {
  state: string | Record<string, unknown>;
  questions: Record<string, JevChoiceQuestion>;
}

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});
export type JevChoiceAnswer = z.infer<typeof ChoiceAnswer>;

const Reply = z.object({
  model: z.string(),
  answers: z.record(z.string(), ChoiceAnswer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export interface JevReply {
  /** The versioned model that answered, never the alias. */
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  usage: ModelUsage;
  /** Wall time of the call, retries included. */
  latencyMs: number;
}

/** The judge's seam onto Jev; tests inject recorded replies here. */
export interface JevPort {
  readonly model: string;
  decide(request: JevRequest): Promise<JevReply>;
}

export interface JevPortOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts on 429 and 529 before the call fails. */
  attempts?: number;
  timeoutMs?: number;
}

const RETRYABLE = new Set([429, 529]);

function backoffOf(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const wanted = Number.isFinite(header) && header > 0 ? header * 1000 : 250 * 2 ** attempt;
  return Math.min(wanted, 5000);
}

/** Calls POST /v1/systemone; overload and rate limits back off, anything else throws. */
export function createJevPort(options: JevPortOptions): JevPort {
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const attempts = options.attempts ?? 3;
  const url = `${(options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
  return {
    model: options.model,
    async decide(request) {
      const started = now();
      const body = JSON.stringify({ model: options.model, ...request });
      for (let attempt = 0; ; attempt += 1) {
        const response = await call(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
        if (RETRYABLE.has(response.status) && attempt + 1 < attempts) {
          await sleep(backoffOf(response, attempt));
          continue;
        }
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`jev answered ${String(response.status)}: ${text.slice(0, 200)}`);
        }
        const parsed = Reply.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error("jev reply does not match the documented shape");
        return {
          model: parsed.data.model,
          answers: parsed.data.answers,
          usage: {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
          },
          latencyMs: Math.round(now() - started),
        };
      }
    },
  };
}
