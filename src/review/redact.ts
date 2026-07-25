import { ToolError } from "../errors.js";

export interface RedactionPattern {
  name: string;
  regex: RegExp;
}

/**
 * Built-in secret and PII shapes. Deliberately absent: generic long-hex
 * matching, because diffs are full of legitimate 40-hex object ids. This net
 * is best-effort by construction; opt into {@link STRICT_PATTERNS} for more, or
 * point the reviewer at a local model when nothing may leave the network.
 */
const BUILT_IN: readonly RedactionPattern[] = [
  {
    name: "private-key-block",
    regex: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z ]*PRIVATE KEY-{5}/g,
  },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "api-key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g },
  // [ \t] only: \s would cross newlines and swallow diff line markers
  { name: "bearer-token", regex: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/g },
  // credentials embedded in a connection string or url; scheme and host are kept
  { name: "basic-auth", regex: /(?<=:\/\/)[^\s:/@]*:[^\s:/@]+(?=@)/g },
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/**
 * Opt-in strict shapes, applied only when `redaction.strict` is set. Aggressive
 * by design: a long value assigned to a secret-named key is redacted even with
 * no known vendor prefix, trading false positives for coverage. Off by default.
 */
export const STRICT_PATTERNS: readonly RedactionPattern[] = [
  {
    name: "assigned-secret",
    regex:
      /(?<=(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]{1,2}\s*["'])[^"'\s]{16,}(?=["'])/gi,
  },
];

export interface RedactedDiff {
  text: string;
  /** Replacement counts per pattern name; empty when nothing matched. */
  counts: Record<string, number>;
}

export function compileCustomPatterns(
  custom: readonly { name: string; pattern: string }[],
): RedactionPattern[] {
  return custom.map(({ name, pattern }) => {
    try {
      return { name, regex: new RegExp(pattern, "g") };
    } catch (error) {
      throw new ToolError(
        `redaction pattern "${name}" does not compile (${(error as Error).message}); aborting before anything reaches the model`,
      );
    }
  });
}

/** Redacts the diff; any failure aborts the review rather than leaking. */
export function redactDiff(
  diff: string,
  custom: readonly RedactionPattern[] = [],
  options: { strict?: boolean } = {},
): RedactedDiff {
  const counts: Record<string, number> = {};
  let text = diff;
  const active = [...BUILT_IN, ...(options.strict === true ? STRICT_PATTERNS : []), ...custom];
  try {
    for (const { name, regex } of active) {
      text = text.replaceAll(regex, () => {
        counts[name] = (counts[name] ?? 0) + 1;
        return `[redacted:${name}]`;
      });
    }
  } catch (error) {
    throw new ToolError(
      `redaction failed (${(error as Error).message}); aborting before anything reaches the model`,
    );
  }
  return { text, counts };
}
