export interface ScmComment {
  id: string;
  body: string;
  path?: string;
  line?: number;
  /** Stable id of the comment's author, where the host exposes one. */
  authorId?: string;
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

export interface InsightAnnotation {
  /** Stable identity (the finding fingerprint); hosts upsert by it. */
  externalId: string;
  title: string;
  summary: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  path: string;
  line: number;
  /** The cited guideline on the host, when it has a web link. */
  link?: string;
}

/** A native report card plus inline annotations (Bitbucket Code Insights). */
export interface InsightReport {
  title: string;
  result: "PASSED" | "FAILED";
  details: string;
  counts: { label: string; value: number }[];
  annotations: InsightAnnotation[];
}

/** A top-level comment plus the team's reaction to it; the learn command's raw material. */
export interface CommentSignal {
  body: string;
  path?: string;
  line?: number;
  /** True when the token's own user wrote it; set by hosts that identify by author. */
  own?: boolean;
  reactions: { up: number; down: number };
  replies: string[];
}

/**
 * What a review needs from a source-code-management host. Adapters speak
 * real HTTP; tests point them at a request-asserting fake server.
 */
export interface ScmPort {
  /**
   * False where the host prints HTML comments verbatim (Bitbucket): the
   * reviewer's comments are then known by author plus heading, not by marker.
   * Absent means the host hides them.
   */
  readonly hidesHtmlComments?: boolean;
  /** Fence language for a suggested change; absent means GitHub's one-click `suggestion`. */
  readonly suggestionFence?: string;
  /** The token's own user id, matched against ScmComment.authorId. */
  currentUserId?(): Promise<string>;
  /** Web link to a repository file on a branch, for guideline and docs links. */
  fileUrl?(path: string, branch: string): string;
  /** Inline review comments previously posted (any author; callers filter by marker). */
  listInlineComments(): Promise<ScmComment[]>;
  createInlineComment(comment: NewInlineComment): Promise<void>;
  updateComment(id: string, body: string): Promise<void>;
  deleteComment(id: string): Promise<void>;
  /** Top-level conversation comments, for the summary. */
  listSummaryComments(): Promise<ScmComment[]>;
  createSummaryComment(body: string): Promise<void>;
  updateSummaryComment(id: string, body: string): Promise<void>;
  /** Commit status on the PR head, reflecting the gate; name is what readers see. */
  postStatus(state: StatusState, description: string, name?: string): Promise<void>;
  /** The PR diff as the host computes it; the fallback when no usable clone exists. */
  fetchPullRequestDiff?(): Promise<string>;
  /** Inline comments with reactions and replies attached; degrades per host. */
  listCommentSignals?(): Promise<CommentSignal[]>;
  /** Publish a native report card with annotations; only some hosts have one. */
  publishInsights?(report: InsightReport): Promise<void>;
  /** The PR author handle, for contributor stats; empty when the host hides it. */
  getPullRequestAuthor?(): Promise<string>;
  /** The PR title and description, for commands that manage a section of them. */
  getPullRequestText?(): Promise<PullRequestText>;
  /** Update the description, and the title only when one is given. */
  updatePullRequestText?(text: { title?: string; body: string }): Promise<void>;
}
