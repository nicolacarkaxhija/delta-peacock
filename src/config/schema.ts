import { z } from "zod";
import { SEVERITIES } from "../domain/severity.js";

export const DEFAULT_DISPLAY_NAME = "Code review";

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
  /** Guideline packs: local paths (repo-root relative) or pinned git URLs; local guidelines win collisions. */
  packs: z.array(z.string().min(1)).default([]),
  /**
   * A guideline missing languages/paths in its frontmatter: lenient (default)
   * keeps it — applying everywhere — with a notice naming the gap; strict
   * skips the rule entirely with a warning instead.
   */
  frontmatterContract: z.enum(["lenient", "strict"]).default("lenient"),
  /** Fetch the target from origin before diffing so stale local refs never lie (ADR 0004). */
  fetchTarget: z.boolean().default(true),
  /** Commit last reviewed; when set and still reachable, only newer changes are reviewed. */
  lastReviewedCommit: z.string().min(1).optional(),
  /** Path globs; empty include means everything, exclude always wins. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  /** Reviews larger than this are skipped, never truncated. */
  maxDiffBytes: z.number().int().positive().default(1_000_000),
  /** Findings under this confidence stay in the report but are never rendered or posted. */
  confidenceFloor: z.number().min(0).max(1).default(0.5),
  /** Opt-in: let the model report observations that cite no guideline. */
  generalPass: z.boolean().default(false),
  /** Opt-in: turn recurring uncited candidates into promotable guideline drafts. */
  harvestUncited: z.boolean().default(false),
  /** The most severe an observation can ever be. */
  observationSeverityCap: z.enum(SEVERITIES).default("MINOR"),
  /** How many proposed guidelines a single review may surface. */
  maxProposedGuidelines: z.number().int().min(0).default(3),
  /** Accepted legacy findings; entries inform but never gate. */
  baselinePath: z.string().min(1).default("delta-peacock.baseline.json"),
  /** BCP 47 tag for finding prose; ids, severities and markers stay English. */
  language: z.string().min(2).default("en"),
  /** Target token window the assembled prompt should fit inside. */
  windowTokens: z.number().int().positive().default(100_000),
  /**
   * Attention budget: a batch never reviews more files than this, however
   * much of the window remains unused. Per-file recall degrades with how
   * many files share a batch long before the token window binds, so fitting
   * the window is necessary but not sufficient.
   */
  maxFilesPerBatch: z.number().int().positive().default(25),
  /** Attention budget: a batch never reviews more (approximate) tokens than this, independent of windowTokens. */
  maxTokensPerBatch: z.number().int().positive().default(30_000),
  /** The reviewer's name on the pull request: summary heading, commit status, insights report. */
  displayName: z.string().trim().min(1).max(40).default(DEFAULT_DISPLAY_NAME),
  /** Repository doc explaining how reviews work; a blocked summary links it when the file exists. */
  guidePath: z.string().min(1).default("docs/reviews.md"),
  /** Post a summary comment on a clean run even where a Code Insights card carries the result. */
  summaryWhenClean: z.boolean().default(false),
  /** The reviewed repository's own config, read for the tags it declares; empty turns it off. */
  repoConfigPath: z.string().default("test-runner.config.ts"),
});

export const GateSchema = z.strictObject({
  failOn: z.enum(["none", ...SEVERITIES]).default("none"),
});

export const OutputSchema = z.strictObject({
  report: z.string().min(1).optional(),
  /** SARIF 2.1.0 artifact for code scanning UIs. */
  sarifPath: z.string().min(1).optional(),
  /** GitLab Code Quality artifact for the MR widget. */
  codeQualityPath: z.string().min(1).optional(),
});

const MODEL_PROVIDERS = ["anthropic", "bedrock", "openrouter", "openai-compatible"] as const;

/** One reviewing model: always a provider plus model pair, never a bare id. */
export const ModelRefSchema = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS),
  id: z.string().min(1),
  baseUrl: z.url().optional(),
});

export const EnsembleSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Reviewing members; each runs the same request in parallel. */
  members: z.array(ModelRefSchema).default([]),
  /** union merges everything; judge adds one reconciliation call. */
  mode: z.enum(["union", "judge"]).default("union"),
  judge: ModelRefSchema.optional(),
});

/** Opt-in per-contributor ledger; a coaching aid, disabled by default. */
export const StatsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** JSONL ledger location; one record appended per review. */
  path: z.string().min(1).default("delta-peacock.stats.jsonl"),
});

/** On-disk response reuse for re-triggered runs on unchanged changesets. */
export const CacheSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Entries older than this never serve; re-runs refresh them. */
  ttlHours: z.number().positive().default(24),
  /** Store for cached replies; defaults inside .delta-peacock-cache. */
  path: z.string().min(1).optional(),
});

/** The optional noise-control pass between parsing and publishing. */
export const CalibrationSchema = z.strictObject({
  /** Off by default: enabling adds exactly one priced model call per review. */
  enabled: z.boolean().default(false),
  /** A cheap model for the pass; the review model serves when unset. */
  model: ModelRefSchema.optional(),
});

/** How the rag strategy retrieves: lexical TF-IDF or real embeddings. */
export const RagSchema = z.strictObject({
  backend: z.enum(["tfidf", "embeddings"]).default("tfidf"),
  /** Where embedding vectors come from when the backend is embeddings. */
  provider: z.enum(["openai-compatible", "bedrock"]).default("openai-compatible"),
  /** Embedding model id; required when the backend is embeddings. */
  model: z.string().min(1).optional(),
  /** Embeddings endpoint for openai-compatible hosts (OpenAI, Ollama, vLLM). */
  baseUrl: z.url().optional(),
});

export const ContextSchema = z.strictObject({
  /** Cross-file awareness strategy; repo_map costs zero extra model calls. */
  provider: z
    .enum(["none", "repo_map", "agentic", "rag", "scope", "full_files"])
    .default("repo_map"),
  /**
   * Layered strategies, applied in order (earlier wins the token budget).
   * Non-empty wins over provider; full_files plus agentic gives whole files and on-demand digging.
   */
  providers: z.array(z.enum(["repo_map", "agentic", "rag", "scope", "full_files"])).default([]),
  /** Ceiling for injected context, measured in approximate tokens. */
  maxTokens: z.number().int().positive().default(4000),
  /** Bound on agentic tool rounds before the model must conclude. */
  maxToolRounds: z.number().int().min(1).max(20).default(6),
  rag: RagSchema.prefault({}),
});

/** USD per million tokens; zero leaves the review unpriced. */
export const CostSchema = z.strictObject({
  rateInputPer1M: z.number().min(0).default(0),
  rateOutputPer1M: z.number().min(0).default(0),
  rateCacheReadPer1M: z.number().min(0).default(0),
  rateCacheWritePer1M: z.number().min(0).default(0),
  /** Rates keyed by model id; the entry for the model in use wins over the flat keys above. */
  rates: z
    .record(
      z.string().min(1),
      z.strictObject({
        rateInputPer1M: z.number().min(0).optional(),
        rateOutputPer1M: z.number().min(0).optional(),
        rateCacheReadPer1M: z.number().min(0).optional(),
        rateCacheWritePer1M: z.number().min(0).optional(),
      }),
    )
    .default({}),
  /** USD per million embedded tokens; prices the rag embeddings backend. */
  rateEmbedPer1M: z.number().min(0).default(0),
  /** Pre-flight ceiling per review in USD; zero switches the check off. */
  maxPerReview: z.number().min(0).default(0),
  /** Cumulative monthly ceiling in USD; zero switches the check off. */
  monthlyCap: z.number().min(0).default(0),
  /** Where month-to-date spending is read from for the monthly cap. */
  spendSource: z.enum(["counter", "aws-cost-explorer"]).default("counter"),
  /** Store for the local spend counter; defaults to the user's home directory. */
  counterPath: z.string().min(1).optional(),
});

export const ScmSchema = z.strictObject({
  provider: z.enum(["github", "gitlab", "bitbucket", "local"]).default("local"),
  /** owner/repo on GitHub, group/project on GitLab, workspace/repo on Bitbucket. */
  repository: z.string().min(1).optional(),
  pullRequest: z.number().int().positive().optional(),
  /** Post a commit status reflecting the gate. */
  commitStatus: z.boolean().default(true),
  /** Post inline and summary comments; off means commentless publication. */
  comments: z.boolean().default(true),
  /** Publish a native report card with annotations (Bitbucket Code Insights); unset means on for Bitbucket. */
  codeInsights: z.boolean().optional(),
  /** One pull request task per posted finding (Bitbucket); resolved by the reviewer once the line changes. */
  tasks: z.boolean().default(false),
  /** API base override for enterprise hosts and tests. */
  baseUrl: z.url().optional(),
  /** The hard guarantee: no write of any kind leaves the process. */
  dryRun: z.boolean().default(false),
});

export const RedactionSchema = z.strictObject({
  /** Extra patterns applied on top of the built-ins; each compiles as a global RegExp. */
  patterns: z
    .array(z.strictObject({ name: z.string().min(1), pattern: z.string().min(1) }))
    .default([]),
  /** Add the aggressive strict shapes (long values assigned to secret-named keys). */
  strict: z.boolean().default(false),
});

export const ConfigSchema = z
  .strictObject({
    model: ModelSchema.prefault({}),
    review: ReviewSchema.prefault({}),
    gate: GateSchema.prefault({}),
    output: OutputSchema.prefault({}),
    redaction: RedactionSchema.prefault({}),
    scm: ScmSchema.prefault({}),
    cost: CostSchema.prefault({}),
    context: ContextSchema.prefault({}),
    ensemble: EnsembleSchema.prefault({}),
    calibration: CalibrationSchema.prefault({}),
    cache: CacheSchema.prefault({}),
    stats: StatsSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.model.provider === "openai-compatible" && config.model.baseUrl === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["model", "baseUrl"],
        message: "model.baseUrl is required when model.provider is openai-compatible",
      });
    }
    if (config.context.rag.backend === "embeddings") {
      if (config.context.rag.model === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["context", "rag", "model"],
          message: "context.rag.model is required when context.rag.backend is embeddings",
        });
      }
      if (
        config.context.rag.provider === "openai-compatible" &&
        config.context.rag.baseUrl === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["context", "rag", "baseUrl"],
          message:
            "context.rag.baseUrl is required when the embeddings provider is openai-compatible",
        });
      }
    }
    if (new Set(config.context.providers).size !== config.context.providers.length) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "providers"],
        message: "context.providers lists a strategy twice",
      });
    }
    if (config.ensemble.enabled && config.ensemble.members.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["ensemble", "members"],
        message: "ensemble.members needs at least one provider and model pair when enabled",
      });
    }
    if (
      config.ensemble.enabled &&
      config.ensemble.mode === "judge" &&
      config.ensemble.judge === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ensemble", "judge"],
        message: "ensemble.judge is required when ensemble.mode is judge",
      });
    }
    // every openai-compatible model ref needs a real baseUrl, not only
    // config.model: an ensemble member, its judge, or the calibration model
    // can just as easily point at a local host with no default endpoint
    for (const [index, member] of config.ensemble.members.entries()) {
      if (member.provider === "openai-compatible" && member.baseUrl === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["ensemble", "members", index, "baseUrl"],
          message: `ensemble.members[${String(index)}].baseUrl is required when its provider is openai-compatible`,
        });
      }
    }
    if (
      config.ensemble.judge?.provider === "openai-compatible" &&
      config.ensemble.judge.baseUrl === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ensemble", "judge", "baseUrl"],
        message: "ensemble.judge.baseUrl is required when its provider is openai-compatible",
      });
    }
    if (
      config.calibration.model?.provider === "openai-compatible" &&
      config.calibration.model.baseUrl === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["calibration", "model", "baseUrl"],
        message: "calibration.model.baseUrl is required when its provider is openai-compatible",
      });
    }
    if (config.scm.provider !== "local") {
      if (config.scm.repository === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["scm", "repository"],
          message: `scm.repository is required when scm.provider is ${config.scm.provider}`,
        });
      }
      if (config.scm.pullRequest === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["scm", "pullRequest"],
          message: `scm.pullRequest is required when scm.provider is ${config.scm.provider}`,
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
