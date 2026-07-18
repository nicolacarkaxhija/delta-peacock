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

export interface PullRequestText {
  title: string;
  body: string;
}

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
  /** The PR diff as the host computes it; the fallback when no usable clone exists. */
  fetchPullRequestDiff?(): Promise<string>;
  /** The PR title and description, for commands that manage a section of them. */
  getPullRequestText?(): Promise<PullRequestText>;
  /** Update the description, and the title only when one is given. */
  updatePullRequestText?(text: { title?: string; body: string }): Promise<void>;
}
