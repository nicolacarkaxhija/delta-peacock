import type { Credentials } from "../config/credentials.js";
import { ConfigError } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { ToolError } from "../errors.js";
import { createBitbucketPort } from "./bitbucket.js";
import { createGitHubPort } from "./github.js";
import { createGitLabPort } from "./gitlab.js";
import type { ScmPort } from "./port.js";

/**
 * Which pull request a run publishes to: the configured number, else on GitHub
 * the open one of the branch. Throws when neither is there to go on.
 */
export function pullRequestTarget(
  config: Config,
  branch: string | undefined,
): { pullRequest: number } | { branch: string } {
  const { pullRequest, provider } = config.scm;
  if (pullRequest !== undefined) return { pullRequest };
  if (provider === "github" && branch !== undefined) return { branch };
  return missingPullRequest(config);
}

function missingPullRequest(config: Config): never {
  throw new ConfigError([
    `scm.pullRequest: scm.pullRequest is required when scm.provider is ${config.scm.provider}`,
  ]);
}

/**
 * Callers guarantee the provider is not local; the schema guarantees the repository.
 * A branch lets the github provider find the pull request when no number is set.
 */
export function buildScmPort(
  config: Config,
  credentials: Credentials,
  ciBuildUrl?: string,
  branch?: string,
): ScmPort {
  const repository = config.scm.repository ?? "";
  if (config.scm.provider === "github") {
    const token = credentials.GITHUB_TOKEN;
    if (token === undefined || token === "") {
      throw new ToolError("GITHUB_TOKEN is not set; the github provider needs it");
    }
    return createGitHubPort({
      repository,
      ...pullRequestTarget(config, branch),
      token,
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  if (config.scm.provider === "bitbucket") {
    const token = credentials.BITBUCKET_TOKEN;
    if (token === undefined || token === "") {
      throw new ToolError("BITBUCKET_TOKEN is not set; the bitbucket provider needs it");
    }
    return createBitbucketPort({
      repository,
      pullRequest: config.scm.pullRequest ?? missingPullRequest(config),
      token,
      ...(ciBuildUrl !== undefined ? { statusUrl: ciBuildUrl } : {}),
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  if (config.scm.provider === "gitlab") {
    const token = credentials.GITLAB_TOKEN;
    if (token === undefined || token === "") {
      throw new ToolError("GITLAB_TOKEN is not set; the gitlab provider needs it");
    }
    return createGitLabPort({
      repository,
      pullRequest: config.scm.pullRequest ?? missingPullRequest(config),
      token,
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  throw new ToolError(
    `scm provider "${config.scm.provider}" is not wired up; github, gitlab, bitbucket and local are available`,
  );
}
