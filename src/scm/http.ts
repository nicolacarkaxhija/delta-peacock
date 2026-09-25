import { ToolError } from "../errors.js";

/** A repository slug fails the given shape; reported with the adapter's own wording. */
export function assertSafeRepository(
  repository: string,
  pattern: RegExp,
  describe: (repository: string) => string,
): void {
  if (!pattern.test(repository)) {
    throw new ToolError(describe(repository));
  }
}

/** Strips a trailing slash so callers can join `${base}/path` without doubling it. */
export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl ?? fallback).replace(/\/$/, "");
}

export interface StatusHandler {
  status: number;
  /** Builds the ToolError message; sees the response for cases like a rate-limit header. */
  toMessage: (response: Response) => string;
}

/**
 * Fetches once and maps well-known statuses to actionable ToolErrors, in the
 * order given, before falling back to a generic "provider responded N" error.
 * Adapters keep their own status handlers and fallback wording; this owns
 * only the fetch-then-map shape all three repeated.
 */
export async function httpRequest(
  url: string,
  init: RequestInit,
  statusHandlers: readonly StatusHandler[],
  fallback: (status: number, detail: string) => string,
): Promise<Response> {
  const response = await fetch(url, init);
  for (const handler of statusHandlers) {
    if (response.status === handler.status) {
      throw new ToolError(handler.toMessage(response));
    }
  }
  if (!response.ok) {
    throw new ToolError(fallback(response.status, await errorDetail(response)));
  }
  return response;
}

const DETAIL_LIMIT = 300;

/** The start of an error body, one line, so a 400 names the rejected fields. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}...` : text;
  } catch {
    return "";
  }
}

/**
 * Follows a page chain until the callback reports no next state, collecting
 * every item along the way. `state` is opaque: a cursor URL for host APIs
 * that hand back a `next` link, or a page number for ones that count pages.
 */
export async function collectAllPages<T, S>(
  initial: S,
  fetchPage: (state: S) => Promise<{ items: T[]; next: S | undefined }>,
): Promise<T[]> {
  const all: T[] = [];
  let state: S | undefined = initial;
  while (state !== undefined) {
    const page = await fetchPage(state);
    all.push(...page.items);
    state = page.next;
  }
  return all;
}
