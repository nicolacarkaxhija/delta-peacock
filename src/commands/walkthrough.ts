import path from "node:path";
import type { RuntimeDeps } from "../deps.js";
import { SEVERITIES } from "../domain/severity.js";
import { DEFAULT_ANSWERS, planScaffold, writeScaffold, type WalkthroughAnswers } from "./init.js";
import { stdinReader } from "./line-reader.js";

/** One walkthrough step: options with their trade-offs, a prompt, a validator. */
interface Question<T> {
  intro: readonly string[];
  /** Shown before the cursor; names the safe default in brackets. */
  prompt: string;
  /** undefined marks an invalid answer; the session re-prompts with the hint. */
  parse: (input: string) => T | undefined;
  hint: string;
}

const SCM_QUESTION: Question<WalkthroughAnswers["scm"]> = {
  intro: [
    "Where should review findings land?",
    "  local      terminal and CI logs only; nothing is posted, no SCM token needed",
    "  github     inline pull request comments; scaffolds a GitHub Actions workflow",
    "  gitlab     inline merge request comments; scaffolds a .gitlab-ci.yml snippet",
    "  bitbucket  inline pull request comments; scaffolds a Bitbucket Pipelines snippet",
  ],
  prompt: "scm host [local]",
  parse: (input) => {
    const value = input.toLowerCase();
    return value === "local" || value === "github" || value === "gitlab" || value === "bitbucket"
      ? value
      : undefined;
  },
  hint: "answer local, github, gitlab or bitbucket",
};

const PROVIDER_QUESTION: Question<WalkthroughAnswers["provider"]> = {
  intro: [
    "Which model provider reviews the code?",
    "  anthropic          the direct API; simplest start, needs ANTHROPIC_API_KEY",
    "  bedrock            traffic stays inside your AWS account; needs AWS credentials",
    "  openrouter         one key across many models; needs OPENROUTER_API_KEY",
    "  openai-compatible  any /v1 endpoint such as Ollama or vLLM; check the baseUrl it writes",
  ],
  prompt: "model provider [anthropic]",
  parse: (input) => {
    const value = input.toLowerCase();
    return value === "anthropic" ||
      value === "bedrock" ||
      value === "openrouter" ||
      value === "openai-compatible"
      ? value
      : undefined;
  },
  hint: "answer anthropic, bedrock, openrouter or openai-compatible",
};

const GATE_QUESTION: Question<WalkthroughAnswers["failOn"]> = {
  intro: [
    "Should findings fail the build?",
    "  advisory   findings inform but never break the build; best while the team builds trust",
    "  a severity fails the build when a finding at or above it survives review;",
    "             CRITICAL is a common first gate: strict where it matters, quiet elsewhere",
  ],
  prompt: "gate [advisory]",
  parse: (input) => {
    const lower = input.toLowerCase();
    if (lower === "advisory" || lower === "none") return "none";
    const upper = input.toUpperCase();
    return SEVERITIES.find((severity) => severity === upper);
  },
  hint: "answer advisory, BLOCKER, CRITICAL, MAJOR, MINOR or INFO",
};

const CONTEXT_QUESTION: Question<WalkthroughAnswers["context"]> = {
  intro: [
    "How much of the repository should the model see beyond the diff?",
    "  repo_map           a map of related files; cross-file awareness at zero extra model calls",
    "  repo_map+agentic   the model may also open related files; sharper, a few extra priced calls",
    "  none               the diff only; cheapest, misses cross-file breakage",
  ],
  prompt: "context strategy [repo_map]",
  parse: (input) => {
    const value = input.toLowerCase();
    return value === "repo_map" || value === "repo_map+agentic" || value === "none"
      ? value
      : undefined;
  },
  hint: "answer repo_map, repo_map+agentic or none",
};

const CAP_QUESTION: Question<number> = {
  intro: [
    "Cap spending per review?",
    "  none       no ceiling; every review runs",
    "  an amount  a USD ceiling; a review estimated above it is blocked before any",
    "             model call (set the cost.rate* fields later so the estimate has prices)",
  ],
  prompt: "per-review cap in USD [none]",
  parse: (input) => {
    if (input.toLowerCase() === "none") return 0;
    const amount = Number(input);
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
  },
  hint: "answer none or a dollar amount like 0.25",
};

const GUIDELINES_QUESTION: Question<string> = {
  intro: [
    "Where do guideline markdown files live?",
    "  a directory inside the repository; guidelines is what the docs and defaults assume",
  ],
  prompt: "guidelines directory [guidelines]",
  parse: (input) =>
    path.isAbsolute(input) || input.split(/[\\/]/).includes("..") ? undefined : input,
  hint: "answer a relative directory inside the repository, like guidelines or docs/rules",
};

/** Raised when the line source dries up mid-session; nothing may be written then. */
class EndOfInput extends Error {}

/**
 * The guided flavor of init: six questions, each with a safe default, then
 * the same scaffold plain init writes, rendered from the answers.
 */
export async function runInitWalkthrough(
  deps: RuntimeDeps,
  options: { force: boolean },
): Promise<number> {
  // the reader only comes to life when a line is actually needed (ask's pattern)
  let reader: (() => Promise<string | null>) | undefined;
  const nextLine = async (): Promise<string | null> => {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- ??= would smear the v8 ignore across covered lines
    if (reader === undefined) {
      /* v8 ignore next 2 -- the real stdin reader; tests always inject readLine */
      reader = deps.readLine ?? (await stdinReader());
    }
    return reader();
  };

  const ask = async <T>(question: Question<T>, fallback: T): Promise<T> => {
    deps.out(`\n${question.intro.join("\n")}\n`);
    for (;;) {
      deps.out(`${question.prompt}: `);
      const line = await nextLine();
      if (line === null) throw new EndOfInput();
      const input = line.trim();
      if (input === "") return fallback;
      const parsed = question.parse(input);
      if (parsed !== undefined) return parsed;
      deps.out(`${question.hint}\n`);
    }
  };

  deps.out("delta-peacock guided setup; press enter to accept a [default]\n");
  const answers: WalkthroughAnswers = { ...DEFAULT_ANSWERS };
  try {
    answers.scm = await ask(SCM_QUESTION, DEFAULT_ANSWERS.scm);
    answers.provider = await ask(PROVIDER_QUESTION, DEFAULT_ANSWERS.provider);
    answers.failOn = await ask(GATE_QUESTION, DEFAULT_ANSWERS.failOn);
    answers.context = await ask(CONTEXT_QUESTION, DEFAULT_ANSWERS.context);
    answers.maxPerReview = await ask(CAP_QUESTION, DEFAULT_ANSWERS.maxPerReview);
    answers.guidelinesDir = await ask(GUIDELINES_QUESTION, DEFAULT_ANSWERS.guidelinesDir);
  } catch (error) {
    /* v8 ignore next -- nothing but EndOfInput escapes the question loop */
    if (!(error instanceof EndOfInput)) throw error;
    deps.out("\nwalkthrough ended early; nothing was written\n");
    return 1;
  }

  deps.out("\n");
  return writeScaffold(deps, planScaffold(answers), options.force);
}
