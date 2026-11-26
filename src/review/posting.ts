import type { Config } from "../config/schema.js";
import type { Finding } from "../domain/finding.js";

/** Whether a finding that survived every validator is posted. */
export function isPosted(
  finding: Finding,
  review: Pick<Config["review"], "posting" | "confidenceFloor">,
): boolean {
  return (finding.confidence ?? 1) >= review.confidenceFloor;
}
