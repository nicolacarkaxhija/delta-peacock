import type { Severity } from "../domain/severity.js";
import type { ReportedFinding } from "./report.js";

/** GitHub code scanning collapses five severities into three levels. */
const SARIF_LEVELS: Record<Severity, "error" | "warning" | "note"> = {
  BLOCKER: "error",
  CRITICAL: "error",
  MAJOR: "warning",
  MINOR: "note",
  INFO: "note",
};

function ruleIdOf(finding: ReportedFinding): string {
  return finding.kind === "violation" ? finding.guidelineId : "observation";
}

/** A SARIF 2.1.0 log: one run, one result per finding, rules from guidelines. */
export function renderSarif(findings: readonly ReportedFinding[]): string {
  const ruleIds = [...new Set(findings.map(ruleIdOf))];
  const log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "delta-peacock",
            informationUri: "https://github.com/nicolacarkaxhija/delta-peacock",
            rules: ruleIds.map((id) => ({
              id,
              shortDescription: {
                text: id === "observation" ? "General-pass observation" : `Guideline ${id}`,
              },
            })),
          },
        },
        results: findings.map((finding) => ({
          ruleId: ruleIdOf(finding),
          level: SARIF_LEVELS[finding.severity],
          message: { text: `${finding.title}\n\n${finding.body}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                region: { startLine: finding.line },
              },
            },
          ],
          partialFingerprints: { deltaPeacockFingerprint: finding.fingerprint },
        })),
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

/** GitLab's Code Quality artifact; the MR widget diffs it between pipelines. */
export function renderCodeQuality(findings: readonly ReportedFinding[]): string {
  const entries = findings.map((finding) => ({
    description: `${finding.title}: ${finding.body}`,
    check_name: ruleIdOf(finding),
    fingerprint: finding.fingerprint,
    severity: finding.severity.toLowerCase(),
    location: { path: finding.file, lines: { begin: finding.line } },
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}
