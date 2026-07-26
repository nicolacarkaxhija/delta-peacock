import type {
  NewInlineComment,
  PullRequestText,
  ScmComment,
  ScmPort,
  StatusState,
} from "./port.js";
import { assertSafeRepository, collectAllPages, httpRequest, normalizeBaseUrl } from "./http.js";

export interface GitLabPortOptions {
  /** group/project; nested subgroups are fine (group/subgroup/project). */
  repository: string;
  /** The merge request iid (the number in the MR URL). */
  pullRequest: number;
  token: string;
  /** Defaults to gitlab.com/api/v4; self-managed hosts and tests override it. */
  baseUrl?: string;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

interface GitLabNote {
  id: number;
  body: string;
  system?: boolean;
  position?: { new_path?: string | null; new_line?: number | null } | null;
}

interface MergeRequestMeta {
  sha: string;
  diff_refs: { base_sha: string; head_sha: string; start_sha: string };
}

const STATUS_STATES: Record<StatusState, string> = {
  success: "success",
  failure: "failed",
  pending: "pending",
};

export function createGitLabPort(options: GitLabPortOptions): ScmPort {
  assertSafeRepository(
    options.repository,
    SAFE_REPOSITORY,
    (repository) =>
      `scm.repository must look like group/project (subgroups allowed), got ${JSON.stringify(repository)}`,
  );
  const base = normalizeBaseUrl(options.baseUrl, "https://gitlab.com/api/v4");
  const project = encodeURIComponent(options.repository);
  const mr = `${base}/projects/${project}/merge_requests/${String(options.pullRequest)}`;
  let meta: MergeRequestMeta | undefined;

  async function request(method: string, url: string, body?: unknown): Promise<Response> {
    return httpRequest(
      url,
      {
        method,
        headers: {
          "private-token": options.token,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      [
        { status: 401, toMessage: () => "GitLab rejected the credentials; check GITLAB_TOKEN" },
        {
          status: 403,
          toMessage: () => "GitLab denied the request (403); the token may lack api scope",
        },
        {
          status: 429,
          toMessage: () => "GitLab rate limit exhausted; retry after the limit resets",
        },
      ],
      (status) => `GitLab responded ${String(status)} to ${method} ${url}`,
    );
  }

  async function listNotes(): Promise<GitLabNote[]> {
    const all = await collectAllPages(1, async (page) => {
      const response = await request(
        "GET",
        `${mr}/notes?per_page=100&page=${String(page)}&sort=asc`,
      );
      const batch = (await response.json()) as GitLabNote[];
      return { items: batch, next: batch.length === 0 ? undefined : page + 1 };
    });
    return all.filter((note) => note.system !== true);
  }

  async function resolveMeta(): Promise<MergeRequestMeta> {
    meta ??= (await (await request("GET", mr)).json()) as MergeRequestMeta;
    return meta;
  }

  const toComment = (note: GitLabNote): ScmComment => ({
    id: String(note.id),
    body: note.body,
    ...(typeof note.position?.new_path === "string" ? { path: note.position.new_path } : {}),
    ...(typeof note.position?.new_line === "number" ? { line: note.position.new_line } : {}),
  });

  return {
    async listInlineComments(): Promise<ScmComment[]> {
      return (await listNotes()).filter((note) => note.position != null).map(toComment);
    },
    async createInlineComment(comment: NewInlineComment): Promise<void> {
      const refs = (await resolveMeta()).diff_refs;
      await request("POST", `${mr}/discussions`, {
        body: comment.body,
        position: {
          position_type: "text",
          base_sha: refs.base_sha,
          head_sha: refs.head_sha,
          start_sha: refs.start_sha,
          new_path: comment.path,
          new_line: comment.line,
        },
      });
    },
    async updateComment(id: string, body: string): Promise<void> {
      await request("PUT", `${mr}/notes/${id}`, { body });
    },
    async deleteComment(id: string): Promise<void> {
      await request("DELETE", `${mr}/notes/${id}`);
    },
    async listSummaryComments(): Promise<ScmComment[]> {
      return (await listNotes()).filter((note) => note.position == null).map(toComment);
    },
    async createSummaryComment(body: string): Promise<void> {
      await request("POST", `${mr}/notes`, { body });
    },
    async updateSummaryComment(id: string, body: string): Promise<void> {
      await request("PUT", `${mr}/notes/${id}`, { body });
    },
    async postStatus(state: StatusState, description: string): Promise<void> {
      const sha = (await resolveMeta()).sha;
      await request("POST", `${base}/projects/${project}/statuses/${sha}`, {
        state: STATUS_STATES[state],
        name: "delta-peacock",
        description,
      });
    },
    async getPullRequestAuthor(): Promise<string> {
      const current = (await (await request("GET", mr)).json()) as {
        author?: { username?: string };
      };
      return current.author?.username ?? "";
    },
    async getPullRequestText(): Promise<PullRequestText> {
      const current = (await (await request("GET", mr)).json()) as {
        title: string;
        description: string | null;
      };
      return { title: current.title, body: current.description ?? "" };
    },
    async updatePullRequestText(text: { title?: string; body: string }): Promise<void> {
      await request("PUT", mr, {
        description: text.body,
        ...(text.title !== undefined ? { title: text.title } : {}),
      });
    },
    async fetchPullRequestDiff(): Promise<string> {
      const response = await httpRequest(
        `${mr}/raw_diffs`,
        { headers: { "private-token": options.token, accept: "text/plain" } },
        [],
        (status) => `GitLab responded ${String(status)} to the diff request`,
      );
      return response.text();
    },
  };
}
