export interface ReviewRecord {
  base: string;
  patch: string;
}

export function writeReviewRecord(
  _cwd: string,
  _change: { staged: boolean; target: string },
  _at: Date,
): string | undefined {
  void _cwd;
  void _change;
  void _at;
  throw new Error("not implemented");
}

export function readReviewRecord(_cwd: string, _evidence: string): ReviewRecord | undefined {
  void _cwd;
  void _evidence;
  throw new Error("not implemented");
}
