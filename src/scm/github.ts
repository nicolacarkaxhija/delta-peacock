import type {
  CommentSignal,
  NewInlineComment,
  PullRequestText,
  ScmComment,
  ScmPort,
  StatusState,
} from "./port.js";
import { DEFAULT_DISPLAY_NAME } from "../config/schema.js";
import { NoPullRequestError, ToolError } from "../errors.js";
import { encodeFilePath } from "./addresses.js";
import { assertSafeRepository, collectAllPages, httpRequest, normalizeBaseUrl } from "./http.js";

interface GitHubPortBase {
  /** owner/repo */
  repository: string;
  token: string;
  /** Defaults to api.github.com; tests and enterprise hosts override it. */
  baseUrl?: string;
}

/** The pull request by number, or the open one whose head is the branch. */
export type GitHubPortOptions = GitHubPortBase &
  ({ pullRequest: number } | { branch: string; base: string });

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
  assertSafeRepository(
    options.repository,
    SAFE_REPOSITORY,
    (repository) => `scm.repository must look like owner/repo, got ${JSON.stringify(repository)}`,
  );
  const base = normalizeBaseUrl(options.baseUrl, "https://api.github.com");
  const repo = options.repository;
  let number = "pullRequest" in options ? String(options.pullRequest) : undefined;
  const { branch, base: into } = "branch" in options ? options : { branch: "", base: "" };
  // api.github.com serves github.com; an enterprise API lives under <host>/api/v3
  const web = `${base === "https://api.github.com" ? "https://github.com" : base.replace(/\/api\/v3$/, "")}/${repo}`;
  let headSha: string | undefined;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/vnd.github+json",
          "user-agent": "delta-peacock",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      [
        { status: 401, toMessage: () => "GitHub rejected the credentials; check GITHUB_TOKEN" },
        {
          status: 403,
          toMessage: (response) =>
            response.headers.get("x-ratelimit-remaining") === "0"
              ? "GitHub rate limit exhausted; retry after the limit resets"
              : "GitHub denied the request (403); the token may lack repository permissions",
        },
      ],
      (status) => `GitHub responded ${String(status)} to ${method} ${path}`,
    );
    if (response.status === 204) return undefined;
    return response.json();
  }

  async function paginate(path: string): Promise<GitHubComment[]> {
    return collectAllPages(1, async (page) => {
      const separator = path.includes("?") ? "&" : "?";
      const batch = (await request(
        "GET",
        `${path}${separator}per_page=100&page=${String(page)}`,
      )) as GitHubComment[];
      return { items: batch, next: batch.length === 0 ? undefined : page + 1 };
    });
  }

  /** The pull request number, looked up once from the branch and base when none was given; never a guess among several. */
  async function pullNumber(): Promise<string> {
    if (number === undefined) {
      const owner = repo.slice(0, repo.indexOf("/"));
      const query = `state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(into)}`;
      const open = (await request("GET", `/repos/${repo}/pulls?${query}`)) as { number: number }[];
      const [found, ...others] = open;
      if (found === undefined) throw new NoPullRequestError(branch, into);
      if (others.length > 0) {
        const all = open.map((pull) => `#${String(pull.number)}`).join(", ");
        throw new ToolError(
          `more than one open pull request for this branch: ${branch} into ${into} (${all}); set scm.pullRequest`,
        );
      }
      number = String(found.number);
    }
    return number;
  }

  async function pullPath(suffix = ""): Promise<string> {
    return `/repos/${repo}/pulls/${await pullNumber()}${suffix}`;
  }

  async function resolveHeadSha(): Promise<string> {
    if (headSha === undefined) {
      const meta = (await request("GET", await pullPath())) as {
        head: { sha: string };
      };
      headSha = meta.head.sha;
    }
    return headSha;
  }

  function fileUrl(file: string, ref: string, line?: number): string {
    const anchor = line === undefined ? "" : `#L${String(line)}`;
    return `${web}/blob/${encodeURIComponent(ref)}/${encodeFilePath(file)}${anchor}`;
  }

  const toComment = (comment: GitHubComment): ScmComment => ({
    id: String(comment.id),
    body: comment.body,
    ...(comment.path !== undefined ? { path: comment.path } : {}),
    ...(typeof comment.line === "number" ? { line: comment.line } : {}),
  });

  return {
    async listInlineComments(): Promise<ScmComment[]> {
      return (await paginate(await pullPath("/comments"))).map(toComment);
    },
    async createInlineComment(comment: NewInlineComment): Promise<string> {
      const created = (await request("POST", await pullPath("/comments"), {
        body: comment.body,
        commit_id: await resolveHeadSha(),
        path: comment.path,
        line: comment.line,
        side: "RIGHT",
      })) as GitHubComment;
      return String(created.id);
    },
    async updateComment(id: string, body: string): Promise<void> {
      await request("PATCH", `/repos/${repo}/pulls/comments/${id}`, { body });
    },
    async deleteComment(id: string): Promise<void> {
      await request("DELETE", `/repos/${repo}/pulls/comments/${id}`);
    },
    async listSummaryComments(): Promise<ScmComment[]> {
      return (await paginate(`/repos/${repo}/issues/${await pullNumber()}/comments`)).map(
        toComment,
      );
    },
    async createSummaryComment(body: string): Promise<void> {
      await request("POST", `/repos/${repo}/issues/${await pullNumber()}/comments`, { body });
    },
    async updateSummaryComment(id: string, body: string): Promise<void> {
      await request("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
    },
    async postStatus(state: StatusState, description: string, name?: string): Promise<void> {
      await request("POST", `/repos/${repo}/statuses/${await resolveHeadSha()}`, {
        state,
        description,
        context: name ?? DEFAULT_DISPLAY_NAME,
        target_url: `${web}/pull/${await pullNumber()}`,
      });
    },
    fileUrl,
    commitUrl(sha: string): string {
      return `${web}/commit/${encodeURIComponent(sha)}`;
    },
    commentUrl(id: string): string {
      return `${web}/pull/${String(number)}#discussion_r${id}`;
    },
    async listCommentSignals(): Promise<CommentSignal[]> {
      const all = await paginate(await pullPath("/comments"));
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
    async getPullRequestAuthor(): Promise<string> {
      const meta = (await request("GET", await pullPath())) as {
        user?: { login?: string };
      };
      return meta.user?.login ?? "";
    },
    async getPullRequestText(): Promise<PullRequestText> {
      const meta = (await request("GET", await pullPath())) as {
        title: string;
        body: string | null;
        html_url?: string;
      };
      return { title: meta.title, body: meta.body ?? "", url: meta.html_url };
    },
    async updatePullRequestText(text: { title?: string; body: string }): Promise<void> {
      await request("PATCH", await pullPath(), {
        body: text.body,
        ...(text.title !== undefined ? { title: text.title } : {}),
      });
    },
    async fetchPullRequestDiff(): Promise<string> {
      const response = await httpRequest(
        `${base}${await pullPath()}`,
        {
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: "application/vnd.github.diff",
            "user-agent": "delta-peacock",
          },
        },
        [],
        (status) => `GitHub responded ${String(status)} to the diff request`,
      );
      return response.text();
    },
  };
}
