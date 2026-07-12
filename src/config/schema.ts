import { z } from "zod";
import { SEVERITIES } from "../domain/severity.js";

export const ModelSchema = z.strictObject({
  provider: z
    .enum(["anthropic", "bedrock", "openrouter", "openai-compatible"])
    .default("anthropic"),
  id: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
});

export const ReviewSchema = z.strictObject({
  target: z.string().min(1).default("main"),
  guidelinesDir: z.string().min(1).default("guidelines"),
  /** Where guidelines are read from: target (default, tamper-resistant), source, or a git ref. */
  guidelinesRef: z.string().min(1).default("target"),
  /** Fetch the target from origin before diffing so stale local refs never lie (ADR 0004). */
  fetchTarget: z.boolean().default(true),
  /** Commit last reviewed; when set and still reachable, only newer changes are reviewed. */
  lastReviewedCommit: z.string().min(1).optional(),
  /** Path globs; empty include means everything, exclude always wins. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  /** Reviews larger than this are skipped, never truncated. */
  maxDiffBytes: z.number().int().positive().default(1_000_000),
});

export const GateSchema = z.strictObject({
  failOn: z.enum(["none", ...SEVERITIES]).default("none"),
});

export const OutputSchema = z.strictObject({
  report: z.string().min(1).optional(),
});

export const RedactionSchema = z.strictObject({
  /** Extra patterns applied on top of the built-ins; each compiles as a global RegExp. */
  patterns: z
    .array(z.strictObject({ name: z.string().min(1), pattern: z.string().min(1) }))
    .default([]),
});

export const ConfigSchema = z
  .strictObject({
    model: ModelSchema.prefault({}),
    review: ReviewSchema.prefault({}),
    gate: GateSchema.prefault({}),
    output: OutputSchema.prefault({}),
    redaction: RedactionSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.model.provider === "openai-compatible" && config.model.baseUrl === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["model", "baseUrl"],
        message: "model.baseUrl is required when model.provider is openai-compatible",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
