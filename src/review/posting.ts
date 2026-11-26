import type { Config } from "../config/schema.js";
import type { Finding } from "../domain/finding.js";

/**
 * Whether a finding that survived every validator is posted. Under evidence a
 * violation stands on what the validators checked (its guideline's own
 * sentence, its line on the change, a cleared exclusion verdict), so a sampled
 * confidence near the floor cannot flip it between runs; an observation cites
 * no guideline and keeps the floor.
 */
export function isPosted(
  finding: Finding,
  review: Pick<Config["review"], "posting" | "confidenceFloor">,
): boolean {
  if (review.posting === "evidence" && finding.kind === "violation") return true;
  return (finding.confidence ?? 1) >= review.confidenceFloor;
}
