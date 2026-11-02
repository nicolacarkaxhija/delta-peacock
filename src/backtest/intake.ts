export interface IntakeOutcome {
  file: string;
  case?: string;
  skipped?: string;
}

export function intakeFalsePositives(
  _cwd: string,
  _intakeDir: string,
  _casesDir: string,
): IntakeOutcome[] {
  void _cwd;
  void _intakeDir;
  void _casesDir;
  throw new Error("not implemented");
}
