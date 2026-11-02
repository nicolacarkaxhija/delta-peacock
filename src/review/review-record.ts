export interface ReviewRecord {
  base: string;
  patch: string;
}

export function readReviewRecord(_cwd: string, _evidence: string): ReviewRecord | undefined {
  void _cwd;
  void _evidence;
  throw new Error("not implemented");
}
