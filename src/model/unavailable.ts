import type { Config } from "../config/schema.js";
import { ToolError } from "../errors.js";

/** Why the model could not run: none configured, the provider out of reach, a rate or quota limit, a timeout, a refused credential. */
export type ModelUnavailability =
  "not-configured" | "unreachable" | "limit" | "timeout" | "credential-refused";

/** A model that could not run at all; a review falls back to the checks that need none. */
export class ModelUnavailableError extends ToolError {
  readonly why: ModelUnavailability;

  constructor(why: ModelUnavailability, message: string) {
    super(message);
    this.name = "ModelUnavailableError";
    this.why = why;
  }
}

const LIMIT = /rate.?limit|quota|throttled|throttling|too many (?:requests|tokens)|credit balance/i;
const REFUSED_KEY =
  /invalid (?:x-)?api.?key|incorrect api key|security token included in the request is invalid/i;
const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
// a chain deeper than this is a cycle or noise, never a transport cause
const MAX_DEPTH = 8;

interface Link {
  name: string;
  message: string;
  code: string;
  statusCode: number | undefined;
}

/** The error and every error it wraps: its cause, and a retry's attempts. */
function chain(error: unknown): Link[] {
  const links: Link[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || seen.has(value) || depth > MAX_DEPTH) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    links.push({
      name: typeof record["name"] === "string" ? record["name"] : "",
      message: typeof record["message"] === "string" ? record["message"] : "",
      code: typeof record["code"] === "string" ? record["code"] : "",
      statusCode: typeof record["statusCode"] === "number" ? record["statusCode"] : undefined,
    });
    visit(record["cause"], depth + 1);
    visit(record["lastError"], depth + 1);
    if (Array.isArray(record["errors"])) {
      for (const inner of record["errors"]) visit(inner, depth + 1);
    }
  };
  visit(error, 0);
  return links;
}

/** How a failed model call means the model cannot run, or undefined for any other failure. */
export function unavailability(
  error: unknown,
  credentialRefused: Config["fallback"]["credentialRefused"],
): ModelUnavailability | undefined {
  if (error instanceof ModelUnavailableError) return error.why;
  const links = chain(error);
  if (links.some((link) => link.statusCode === 429 || LIMIT.test(link.message))) return "limit";
  if (
    links.some(
      (link) =>
        link.statusCode === 401 || link.statusCode === 403 || REFUSED_KEY.test(link.message),
    )
  ) {
    return credentialRefused === "fallback" ? "credential-refused" : undefined;
  }
  // any other request the provider refused is no outage
  if (
    links.some(
      (link) =>
        link.statusCode !== undefined &&
        link.statusCode >= 400 &&
        link.statusCode < 500 &&
        link.statusCode !== 408,
    )
  ) {
    return undefined;
  }
  if (
    links.some(
      (link) =>
        link.statusCode === 408 || TIMEOUT_NAMES.has(link.name) || TIMEOUT_CODES.has(link.code),
    )
  ) {
    return "timeout";
  }
  if (
    links.some(
      (link) =>
        UNREACHABLE_CODES.has(link.code) ||
        (link.statusCode !== undefined && link.statusCode >= 500) ||
        link.message.startsWith("Cannot connect to API"),
    )
  ) {
    return "unreachable";
  }
  return undefined;
}
