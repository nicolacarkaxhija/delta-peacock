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
