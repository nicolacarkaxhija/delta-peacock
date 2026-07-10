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
});

export const GateSchema = z.strictObject({
  failOn: z.enum(["none", ...SEVERITIES]).default("none"),
});

export const OutputSchema = z.strictObject({
  report: z.string().min(1).optional(),
});

export const ConfigSchema = z
  .strictObject({
    model: ModelSchema.prefault({}),
    review: ReviewSchema.prefault({}),
    gate: GateSchema.prefault({}),
    output: OutputSchema.prefault({}),
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
