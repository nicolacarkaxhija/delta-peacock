# delta-peacock

Reviews pull requests against the guidelines a team keeps as markdown in its own repository. One context: everything below is the language of that review.

## Language

### The review

**Review**:
One run of the reviewer over one changeset, producing findings and a summary.

**Finding**:
One statement the reviewer makes about the changeset. Every finding is either a violation or an observation.
_Avoid_: issue, comment (that is where a finding may be rendered, not what it is)

**Violation**:
A finding that cites a guideline and inherits that guideline's severity. The model cannot assign a violation's severity.
_Avoid_: error, problem

**Observation**:
A finding from the general pass that cites no guideline. Its severity is capped by configuration and it never gates.
_Avoid_: suggestion (reserved for a rendered fix), warning

**Proposed guideline**:
A sketch attached to an observation recommending the team codify an unwritten rule: a draft id, a suggested severity, and a one-line rationale.

**Fingerprint**:
The stable identity of a finding. Two runs that see the same problem produce the same fingerprint.

**Confidence**:
The model's own certainty in a finding, filtered by a configurable floor.

**Rejected candidate**:
A raw element the model emitted that the parser refused, for one of three reasons: malformed shape, an uncited guideline, or a file outside the cited guideline's scope. A rejected candidate never becomes a finding.
_Avoid_: dropped finding (it was never a finding)

**Assessment**:
A non-gating, model-produced qualitative read of the change along named dimensions such as readability or cohesion, expressed as a coarse band with a one-line rationale. An assessment is never a finding and never sits on the severity scale.
_Avoid_: metric, score

### Guidelines

**Guideline**:
A markdown document in the reviewed repository declaring one reviewable rule, identified by an id and carrying a severity.
_Avoid_: rule, policy, standard, check

**Exclusion**:
A sentence of a guideline, listed in its frontmatter, that names a case never to be a finding under it. Every finding under the guideline is held against its exclusions before it stands.

**Severity**:
How bad a violation is, on exactly five steps: BLOCKER, CRITICAL, MAJOR, MINOR, INFO. Nothing else lives on this scale.

**Target**:
The branch the pull request merges into. Guidelines are read from the target so a pull request cannot weaken the rules that judge it.
_Avoid_: base branch, destination

### The outcome

**Gate**:
The pass or fail decision made by comparing violations against the configured severity threshold.
_Avoid_: strict mode, quality gate

**Advisory**:
The gate posture when no threshold is configured. Findings inform; the build never fails because of them.

**Waiver**:
A reasoned, in-code exception that excuses a single finding on the change under review: the finding no longer gates and is always reported, never silent. A waiver lives in the source under review, so it can excuse a current finding, and it must carry a reason.
_Avoid_: ignore, mute, disable

**Dry run**:
A review with every outbound write suppressed. Nothing reaches the SCM, regardless of what is configured.

**Local mode**:
Reviewing with no SCM configured at all. Findings go to the terminal and the report, and nowhere else.

**Incremental review**:
Reviewing only the changes made since the last reviewed commit. A rebase that breaks the anchor falls back to a full review.

### Strategies

**Port**:
A seam where delta-peacock meets the outside world: SCM, model, context strategy, spend source. Each port has interchangeable adapters.
_Avoid_: integration, connector

**Context strategy**:
A selectable way of giving the model awareness beyond the diff: repo map, agentic, retrieval, or none. Strategies can be layered, in priority order.

**Ensemble**:
Several provider and model pairs reviewing the same changeset. Union merges every member's findings; judge has one model reconcile them.

**Cost guard**:
The pre-flight check that blocks a review expected to exceed the per-review or monthly spending cap.

**Spend source**:
Where month-to-date spending is read from when the monthly cap is checked.

**Bot identity**:
The account delta-peacock posts under, used to recognize a change that is the human-applied form of the reviewer's own suggestion.
_Avoid_: bot user, service account

**House preamble**:
Optional team-authored text inserted into a fixed slot of the review prompt to add standing context. It adds to the review contract and never replaces it.
_Avoid_: custom prompt, system prompt override
