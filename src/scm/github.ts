import { ToolError } from "../errors.js";
import type {
  CommentSignal,
  NewInlineComment,
  PullRequestText,
  ScmComment,
  ScmPort,
  StatusState,
} from "./port.js";

export interface GitHubPortOptions {
  /** owner/repo */
  repository: string;
  pullRequest: number;
  token: string;
  /** Defaults to api.github.com; tests and enterprise hosts override it. */
  baseUrl?: string;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface GitHubComment {
  id: number;
  body: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number;
  reactions?: { "+1"?: number; "-1"?: number };
}

export function createGitHubPort(options: GitHubPortOptions): ScmPort {
  if (!SAFE_REPOSITORY.test(options.repository)) {
    throw new ToolError(
      `scm.repository must look like owner/repo, got ${JSON.stringify(options.repository)}`,
    );
  }
  const base = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const repo = options.repository;
  const pr = String(options.pullRequest);
  let headSha: string | undefined;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "delta-peacock",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      throw new ToolError("GitHub rejected the credentials; check GITHUB_TOKEN");
    }
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      throw new ToolError(
        remaining === "0"
          ? "GitHub rate limit exhausted; retry after the limit resets"
          : "GitHub denied the request (403); the token may lack repository permissions",
      );
    }
    if (!response.ok) {
      throw new ToolError(`GitHub responded ${String(response.status)} to ${method} ${path}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async function paginate(path: string): Promise<GitHubComment[]> {
    const all: GitHubComment[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = (await request(
        "GET",
        `${path}${separator}per_page=100&page=${String(page)}`,
      )) as GitHubComment[];
      all.push(...batch);
      if (batch.length === 0) break;
    }
    return all;
  }

  async function resolveHeadSha(): Promise<string> {
    if (headSha === undefined) {
      const meta = (await request("GET", `/repos/${repo}/pulls/${pr}`)) as {
        head: { sha: string };
      };
      headSha = meta.head.sha;
    }
    return headSha;
  }

  const toComment = (comment: GitHubComment): ScmComment => ({
    id: String(comment.id),
    body: comment.body,
    ...(comment.path !== undefined ? { path: comment.path } : {}),
    ...(typeof comment.line === "number" ? { line: comment.line } : {}),
  });

  return {
    async listInlineComments(): Promise<ScmComment[]> {
      return (await paginate(`/repos/${repo}/pulls/${pr}/comments`)).map(toComment);
    },
    async createInlineComment(comment: NewInlineComment): Promise<void> {
      await request("POST", `/repos/${repo}/pulls/${pr}/comments`, {
        body: comment.body,
        commit_id: await resolveHeadSha(),
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
      });
    },
    async updateComment(id: string, body: string): Promise<void> {
      await request("PATCH", `/repos/${repo}/pulls/comments/${id}`, { body });
    },
    async deleteComment(id: string): Promise<void> {
      await request("DELETE", `/repos/${repo}/pulls/comments/${id}`);
    },
    async listSummaryComments(): Promise<ScmComment[]> {
      return (await paginate(`/repos/${repo}/issues/${pr}/comments`)).map(toComment);
    },
    async createSummaryComment(body: string): Promise<void> {
      await request("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    },
    async updateSummaryComment(id: string, body: string): Promise<void> {
      await request("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
    },
    async postStatus(state: StatusState, description: string): Promise<void> {
      await request("POST", `/repos/${repo}/statuses/${await resolveHeadSha()}`, {
        state,
        description,
        context: "delta-peacock",
      });
    },
    async listCommentSignals(): Promise<CommentSignal[]> {
      const all = await paginate(`/repos/${repo}/pulls/${pr}/comments`);
      const repliesTo = new Map<number, string[]>();
      for (const comment of all) {
        if (comment.in_reply_to_id === undefined) continue;
        const list = repliesTo.get(comment.in_reply_to_id) ?? [];
        list.push(comment.body);
        repliesTo.set(comment.in_reply_to_id, list);
      }
      return all
        .filter((comment) => comment.in_reply_to_id === undefined)
        .map((comment) => ({
          body: comment.body,
          ...(comment.path !== undefined ? { path: comment.path } : {}),
          reactions: {
            up: comment.reactions?.["+1"] ?? 0,
            down: comment.reactions?.["-1"] ?? 0,
          },
          replies: repliesTo.get(comment.id) ?? [],
        }));
    },
    async getPullRequestText(): Promise<PullRequestText> {
      const meta = (await request("GET", `/repos/${repo}/pulls/${pr}`)) as {
        title: string;
        body: string | null;
      };
      return { title: meta.title, body: meta.body ?? "" };
    },
    async updatePullRequestText(text: { title?: string; body: string }): Promise<void> {
      await request("PATCH", `/repos/${repo}/pulls/${pr}`, {
        body: text.body,
        ...(text.title !== undefined ? { title: text.title } : {}),
      });
    },
    async fetchPullRequestDiff(): Promise<string> {
      const response = await fetch(`${base}/repos/${repo}/pulls/${pr}`, {
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/vnd.github.diff",
          "user-agent": "delta-peacock",
        },
      });
      if (!response.ok) {
        throw new ToolError(`GitHub responded ${String(response.status)} to the diff request`);
      }
      return response.text();
    },
  };
}
