import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectCi, type CiProvider } from "../config/ci.js";
import type { RuntimeDeps } from "../deps.js";
import type { Severity } from "../domain/severity.js";
import { resolvePack } from "../guidelines/packs.js";

/** Everything the guided walkthrough can decide; plain init runs on the defaults. */
export interface WalkthroughAnswers {
  scm: "local" | "github" | "gitlab" | "bitbucket";
  provider: "anthropic" | "bedrock" | "openrouter" | "openai-compatible";
  failOn: Severity | "none";
  context: "repo_map" | "repo_map+agentic" | "none";
  /** USD ceiling per review; zero means no cap. */
  maxPerReview: number;
  guidelinesDir: string;
}

export const DEFAULT_ANSWERS: WalkthroughAnswers = {
  scm: "local",
  provider: "anthropic",
  failOn: "none",
  context: "repo_map",
  maxPerReview: 0,
  guidelinesDir: "guidelines",
};

/**
 * Renders the config yaml for a set of answers. Plain init and the
 * all-defaults walkthrough both render DEFAULT_ANSWERS, so their output
 * is identical by construction.
 */
export function renderConfigYaml(answers: WalkthroughAnswers): string {
  const lines = [
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/nicolacarkaxhija/delta-peacock/main/schema/delta-peacock.config.schema.json",
    "# delta-peacock configuration. Secrets never live here; use environment variables.",
    "",
    "model:",
    `  provider: ${answers.provider}`,
    "  # id: claude-sonnet-4-5",
    ...(answers.provider === "openai-compatible"
      ? [
          "  # any OpenAI-style /v1 endpoint; this default is a local Ollama",
          "  baseUrl: http://localhost:11434/v1",
        ]
      : []),
    "",
    "review:",
    "  target: main",
    `  guidelinesDir: ${answers.guidelinesDir}`,
    "",
    "gate:",
    ...(answers.failOn === "none"
      ? ["  # advisory by default; set a severity to gate the build", "  failOn: none"]
      : [
          "  # findings at or above this severity fail the build with exit code 2",
          `  failOn: ${answers.failOn}`,
        ]),
  ];
  if (answers.context === "repo_map+agentic") {
    lines.push(
      "",
      "context:",
      "  # repo map plus agentic file reads; sharper cross-file reviews for a few extra calls",
      "  providers: [repo_map, agentic]",
    );
  } else if (answers.context === "none") {
    lines.push(
      "",
      "context:",
      "  # the model sees the diff only; cheapest, misses cross-file breakage",
      "  provider: none",
    );
  }
  if (answers.maxPerReview > 0) {
    lines.push(
      "",
      "cost:",
      "  # reviews estimated above this many USD are blocked before any model call;",
      "  # set the rate* fields for your model so the estimate has prices to work with",
      `  maxPerReview: ${String(answers.maxPerReview)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const GUIDELINE_TEMPLATE = `---
id: example-no-debug-logging
severity: MINOR
languages: [javascript, typescript]
---
# No debug logging in committed code

Committed code must not call console.log or console.debug. Route anything
worth keeping through the project logger, and delete the rest.
`;

const GITHUB_SNIPPET = `name: delta-peacock
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx delta-peacock review
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          DELTA_PEACOCK_SCM_PROVIDER: github
          DELTA_PEACOCK_SCM_REPOSITORY: \${{ github.repository }}
          DELTA_PEACOCK_SCM_PULL_REQUEST: \${{ github.event.pull_request.number }}
`;

const GENERIC_SNIPPET = `# Run delta-peacock in any CI job with a full clone:
#
#   npx delta-peacock review
#
# Required environment:
#   ANTHROPIC_API_KEY            model credentials (or the provider you configured)
#   DELTA_PEACOCK_MODEL_ID       the model to review with
#
# To post results on a pull request, add:
#   DELTA_PEACOCK_SCM_PROVIDER     github | gitlab | bitbucket
#   DELTA_PEACOCK_SCM_REPOSITORY   owner/repo
#   DELTA_PEACOCK_SCM_PULL_REQUEST the PR number
#   GITHUB_TOKEN, GITLAB_TOKEN or BITBUCKET_TOKEN
`;

const GITLAB_SNIPPET = `# Merge into .gitlab-ci.yml; runs on merge request pipelines.
delta-peacock-review:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - export DELTA_PEACOCK_SCM_PROVIDER=gitlab
    - export DELTA_PEACOCK_SCM_REPOSITORY="$CI_PROJECT_PATH"
    - export DELTA_PEACOCK_SCM_PULL_REQUEST="$CI_MERGE_REQUEST_IID"
    - export DELTA_PEACOCK_REVIEW_TARGET="$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - npx delta-peacock review
# set ANTHROPIC_API_KEY, GITLAB_TOKEN and DELTA_PEACOCK_MODEL_ID as CI/CD variables
`;

export interface PlannedFile {
  relPath: string;
  content: string;
}

const BITBUCKET_SNIPPET = `# Merge into bitbucket-pipelines.yml under pipelines.pull-requests:
- step:
    name: delta-peacock review
    image: node:24
    clone:
      depth: full
    script:
      - export DELTA_PEACOCK_SCM_PROVIDER=bitbucket
      - export DELTA_PEACOCK_SCM_REPOSITORY="$BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG"
      - export DELTA_PEACOCK_SCM_PULL_REQUEST="$BITBUCKET_PR_ID"
      - export DELTA_PEACOCK_REVIEW_TARGET="$BITBUCKET_PR_DESTINATION_BRANCH"
      - npx delta-peacock review
# set ANTHROPIC_API_KEY, BITBUCKET_TOKEN and DELTA_PEACOCK_MODEL_ID as repository variables
`;

const JENKINS_SNIPPET = `// Merge into your Jenkinsfile inside a change-request stage:
stage('delta-peacock review') {
  when { changeRequest() }
  steps {
    sh '''
      export DELTA_PEACOCK_SCM_PROVIDER=bitbucket
      export DELTA_PEACOCK_SCM_PULL_REQUEST="$CHANGE_ID"
      export DELTA_PEACOCK_REVIEW_TARGET="$CHANGE_TARGET"
      npx delta-peacock review
    '''
  }
}
// provide ANTHROPIC_API_KEY, the SCM token and DELTA_PEACOCK_MODEL_ID via credentials
`;

/** The CI snippet each answerable SCM host maps to; jenkins is env-detection only. */
const CI_SNIPPETS: Readonly<Record<WalkthroughAnswers["scm"], PlannedFile>> = {
  local: { relPath: "delta-peacock-ci-snippet.txt", content: GENERIC_SNIPPET },
  github: { relPath: ".github/workflows/delta-peacock.yml", content: GITHUB_SNIPPET },
  gitlab: { relPath: "delta-peacock-gitlab-ci-snippet.yml", content: GITLAB_SNIPPET },
  bitbucket: { relPath: "delta-peacock-pipelines-snippet.yml", content: BITBUCKET_SNIPPET },
};

function ciSnippet(ci: CiProvider): PlannedFile {
  if (ci === "jenkins") {
    return { relPath: "delta-peacock-jenkinsfile-snippet.groovy", content: JENKINS_SNIPPET };
  }
  if (ci === undefined) return CI_SNIPPETS.local;
  return CI_SNIPPETS[ci];
}

/** Pure planning seam: answers in, the three files init writes out. */
export function planScaffold(
  answers: WalkthroughAnswers,
  snippet: PlannedFile = CI_SNIPPETS[answers.scm],
): PlannedFile[] {
  return [
    { relPath: "delta-peacock.config.yaml", content: renderConfigYaml(answers) },
    {
      relPath: `${answers.guidelinesDir}/example-no-debug-logging.md`,
      content: GUIDELINE_TEMPLATE,
    },
    snippet,
  ];
}

/** Writes the planned files, refusing to clobber anything without force. */
export function writeScaffold(
  deps: RuntimeDeps,
  planned: readonly PlannedFile[],
  force: boolean,
): number {
  for (const file of planned) {
    const full = path.join(deps.cwd, file.relPath);
    if (existsSync(full) && !force) {
      deps.out(`kept    ${file.relPath} (exists; pass --force to overwrite)\n`);
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    deps.out(`created ${file.relPath}\n`);
  }

  deps.out(
    "\nnext steps:\n" +
      "  1. set model.id in delta-peacock.config.yaml (or DELTA_PEACOCK_MODEL_ID)\n" +
      "  2. export your model credentials (for anthropic: ANTHROPIC_API_KEY)\n" +
      "  3. run: delta-peacock doctor\n",
  );
  return 0;
}

/** First-ten-minutes scaffolding: config, an example guideline, a CI snippet. */
export function runInit(deps: RuntimeDeps, options: { force: boolean; starter?: string }): number {
  if (options.starter === undefined) {
    return writeScaffold(
      deps,
      planScaffold(DEFAULT_ANSWERS, ciSnippet(detectCi(deps.env))),
      options.force,
    );
  }
  // seed the corpus from a curated pack the human reviews before committing
  const pack = resolvePack(deps.cwd, options.starter);
  const seeded: PlannedFile[] = pack.files.map((file) => {
    const base = path.basename(file.displayPath.split(":").at(-1) ?? "guideline.md");
    return { relPath: `guidelines/${base}`, content: file.content };
  });
  deps.out(`starter pack ${pack.manifest.name}: seeding ${String(seeded.length)} guideline(s)\n`);
  return writeScaffold(
    deps,
    [
      { relPath: "delta-peacock.config.yaml", content: renderConfigYaml(DEFAULT_ANSWERS) },
      ...seeded,
      ciSnippet(detectCi(deps.env)),
    ],
    options.force,
  );
}
