/** A failure of the tool itself, mapped to exit code 1. Never a review outcome. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Carries a deliberate non-zero exit code (e.g. a failed gate) out of a command action. */
export class ExitCodeError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${String(code)}`);
    this.name = "ExitCodeError";
    this.code = code;
  }
}

/** The branch has no open pull request, so there is nothing to publish to. */
export class NoPullRequestError extends ToolError {
  constructor(branch: string) {
    super(`no pull request for this branch: ${branch}`);
    this.name = "NoPullRequestError";
  }
}
