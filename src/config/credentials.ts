/**
 * Credential-shaped environment variables the model and SCM adapters read
 * directly. These never pass through {@link Config}: the loader rejects
 * credential-shaped keys in the config file, and none of these names appear
 * in `ENV_VARS` (ADR 0005). `loadCredentials` is this file's one door onto
 * them, so no adapter or command indexes into raw `process.env` for a
 * secret; everything downstream carries this narrow, typed shape instead.
 */
export interface Credentials {
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly AWS_REGION?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly AWS_SESSION_TOKEN?: string;
  readonly GITHUB_TOKEN?: string;
  readonly BITBUCKET_TOKEN?: string;
  readonly GITLAB_TOKEN?: string;
}

const CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "BITBUCKET_TOKEN",
  "GITLAB_TOKEN",
] as const satisfies readonly (keyof Credentials)[];

/** Narrows raw env down to exactly the credential-shaped values adapters need. */
export function loadCredentials(env: Readonly<Record<string, string | undefined>>): Credentials {
  const credentials: Record<string, string | undefined> = {};
  for (const name of CREDENTIAL_NAMES) {
    if (env[name] !== undefined) credentials[name] = env[name];
  }
  return credentials;
}
