import type { Config } from "../config/schema.js";
import { ToolError } from "../errors.js";
import { createBitbucketPort } from "./bitbucket.js";
import { createGitHubPort } from "./github.js";
import { createGitLabPort } from "./gitlab.js";
import type { ScmPort } from "./port.js";

/** Callers guarantee the provider is not local; the schema guarantees the fields. */
export function buildScmPort(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
): ScmPort {
  const repository = config.scm.repository ?? "";
  const pullRequest = config.scm.pullRequest ?? 0;
  if (config.scm.provider === "github") {
    const token = env["GITHUB_TOKEN"];
    if (token === undefined || token === "") {
      throw new ToolError("GITHUB_TOKEN is not set; the github provider needs it");
    }
    return createGitHubPort({
      repository,
      pullRequest,
      token,
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  if (config.scm.provider === "bitbucket") {
    const token = env["BITBUCKET_TOKEN"];
    if (token === undefined || token === "") {
      throw new ToolError("BITBUCKET_TOKEN is not set; the bitbucket provider needs it");
    }
    return createBitbucketPort({
      repository,
      pullRequest,
      token,
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  if (config.scm.provider === "gitlab") {
    const token = env["GITLAB_TOKEN"];
    if (token === undefined || token === "") {
      throw new ToolError("GITLAB_TOKEN is not set; the gitlab provider needs it");
    }
    return createGitLabPort({
      repository,
      pullRequest,
      token,
      ...(config.scm.baseUrl !== undefined ? { baseUrl: config.scm.baseUrl } : {}),
    });
  }
  throw new ToolError(
    `scm provider "${config.scm.provider}" is not wired up; github, gitlab, bitbucket and local are available`,
  );
}
