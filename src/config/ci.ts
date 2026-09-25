/** Which CI host this process runs under, detected from that host's own ambient signal. */
export type CiProvider = "github" | "gitlab" | "bitbucket" | "jenkins" | undefined;

/**
 * `init`'s one door onto these host-detection variables: nothing else in the
 * codebase reads `GITHUB_ACTIONS`, `GITLAB_CI`, `BITBUCKET_BUILD_NUMBER` or
 * `JENKINS_URL` directly (ADR 0005's environment-reading rule extends to
 * this kind of runtime-ambient signal, not only to Config-shaped settings).
 */
export function detectCi(env: Readonly<Record<string, string | undefined>>): CiProvider {
  if (env["GITHUB_ACTIONS"] !== undefined) return "github";
  if (env["GITLAB_CI"] !== undefined) return "gitlab";
  if (env["BITBUCKET_BUILD_NUMBER"] !== undefined) return "bitbucket";
  if (env["JENKINS_URL"] !== undefined) return "jenkins";
  return undefined;
}

const SAFE_SLUG = /^[A-Za-z0-9_.-]+$/;

/**
 * The absolute URL of the CI run this process belongs to, for status links.
 * Only Bitbucket Pipelines needs it today: its build status API requires a url.
 */
export function ciBuildUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const build = env["BITBUCKET_BUILD_NUMBER"];
  const workspace = env["BITBUCKET_WORKSPACE"];
  const slug = env["BITBUCKET_REPO_SLUG"];
  if (build === undefined || !/^\d+$/.test(build)) return undefined;
  if (workspace === undefined || slug === undefined) return undefined;
  if (!SAFE_SLUG.test(workspace) || !SAFE_SLUG.test(slug)) return undefined;
  return `https://bitbucket.org/${workspace}/${slug}/pipelines/results/${build}`;
}
