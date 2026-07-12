export interface ScmComment {
  id: string;
  body: string;
  path?: string;
  line?: number;
}

export interface NewInlineComment {
  body: string;
  path: string;
  line: number;
}

export type StatusState = "success" | "failure" | "pending";

/**
 * What a review needs from a source-code-management host. Adapters speak
 * real HTTP; tests point them at a request-asserting fake server.
 */
export interface ScmPort {
  /** Inline review comments previously posted (any author; callers filter by marker). */
  listInlineComments(): Promise<ScmComment[]>;
  createInlineComment(comment: NewInlineComment): Promise<void>;
  updateComment(id: string, body: string): Promise<void>;
  deleteComment(id: string): Promise<void>;
  /** Top-level conversation comments, for the summary. */
  listSummaryComments(): Promise<ScmComment[]>;
  createSummaryComment(body: string): Promise<void>;
  updateSummaryComment(id: string, body: string): Promise<void>;
  /** Commit status on the PR head, reflecting the gate. */
  postStatus(state: StatusState, description: string): Promise<void>;
}
