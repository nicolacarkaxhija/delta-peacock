import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeDeps } from "../deps.js";

const CONFIG_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/nicolacarkaxhija/delta-peacock/main/schema/delta-peacock.config.schema.json
# delta-peacock configuration. Secrets never live here; use environment variables.

model:
  provider: anthropic
  # id: claude-sonnet-4-5

review:
  target: main
  guidelinesDir: guidelines

gate:
  # advisory by default; set a severity to gate the build
  failOn: none
`;

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

interface PlannedFile {
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

function ciSnippet(env: RuntimeDeps["env"]): PlannedFile {
  if (env["GITHUB_ACTIONS"] !== undefined) {
    return { relPath: ".github/workflows/delta-peacock.yml", content: GITHUB_SNIPPET };
  }
  if (env["GITLAB_CI"] !== undefined) {
    return { relPath: "delta-peacock-gitlab-ci-snippet.yml", content: GITLAB_SNIPPET };
  }
  if (env["BITBUCKET_BUILD_NUMBER"] !== undefined) {
    return { relPath: "delta-peacock-pipelines-snippet.yml", content: BITBUCKET_SNIPPET };
  }
  if (env["JENKINS_URL"] !== undefined) {
    return { relPath: "delta-peacock-jenkinsfile-snippet.groovy", content: JENKINS_SNIPPET };
  }
  return { relPath: "delta-peacock-ci-snippet.txt", content: GENERIC_SNIPPET };
}

/** First-ten-minutes scaffolding: config, an example guideline, a CI snippet. */
export function runInit(deps: RuntimeDeps, options: { force: boolean }): number {
  const planned: PlannedFile[] = [
    { relPath: "delta-peacock.config.yaml", content: CONFIG_TEMPLATE },
    { relPath: "guidelines/example-no-debug-logging.md", content: GUIDELINE_TEMPLATE },
    ciSnippet(deps.env),
  ];

  for (const file of planned) {
    const full = path.join(deps.cwd, file.relPath);
    if (existsSync(full) && !options.force) {
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
