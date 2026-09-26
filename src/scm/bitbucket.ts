import type {
  CommentSignal,
  InsightReport,
  NewInlineComment,
  PullRequestText,
  ScmComment,
  ScmPort,
  ScmTask,
  StatusState,
} from "./port.js";
import { DEFAULT_DISPLAY_NAME } from "../config/schema.js";
import { assertSafeRepository, collectAllPages, httpRequest, normalizeBaseUrl } from "./http.js";

export interface BitbucketPortOptions {
  /** workspace/repo */
  repository: string;
  pullRequest: number;
  token: string;
  /** Defaults to api.bitbucket.org/2.0; tests override it. */
  baseUrl?: string;
  /** Absolute link a build status points at; the pull request page when absent or invalid. */
  statusUrl?: string;
}

/** Bitbucket requires a build status url and rejects anything but an absolute http(s) one. */
function absoluteHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface BitbucketComment {
  id: number;
  content: { raw: string };
  inline?: { path: string; to?: number | null };
  parent?: { id: number };
  deleted?: boolean;
  user?: { uuid?: string };
  resolution?: unknown;
}

interface BitbucketTask {
  id: number;
  content: { raw: string };
  comment?: { id: number };
  state: string;
  resolved_by?: { uuid?: string } | null;
}

interface Page<T> {
  values: T[];
  next?: string;
}

const STATUS_STATES: Record<StatusState, string> = {
  success: "SUCCESSFUL",
  failure: "FAILED",
  pending: "INPROGRESS",
};

export function createBitbucketPort(options: BitbucketPortOptions): ScmPort {
  assertSafeRepository(
    options.repository,
    SAFE_REPOSITORY,
    (repository) =>
      `scm.repository must look like workspace/repo, got ${JSON.stringify(repository)}`,
  );
  const base = normalizeBaseUrl(options.baseUrl, "https://api.bitbucket.org/2.0");
  const repo = options.repository;
  const pr = String(options.pullRequest);
  const statusUrl =
    absoluteHttpUrl(options.statusUrl) ?? `https://bitbucket.org/${repo}/pull-requests/${pr}`;
  let source: { sha: string; branch: string | undefined } | undefined;
  let self: Promise<string> | undefined;

  async function request(method: string, url: string, body?: unknown): Promise<Response> {
    return httpRequest(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      [
        {
          status: 401,
          toMessage: () => "Bitbucket rejected the credentials; check BITBUCKET_TOKEN",
        },
        {
          status: 403,
          toMessage: () => "Bitbucket denied the request (403); the token may lack permissions",
        },
        {
          status: 429,
          toMessage: () => "Bitbucket rate limit exhausted; retry after the limit resets",
        },
      ],
      (status, detail) =>
        `Bitbucket responded ${String(status)} to ${method} ${url}${detail !== "" ? `: ${detail}` : ""}`,
    );
  }

  async function listComments(): Promise<BitbucketComment[]> {
    const all = await collectAllPages(
      `${base}/repositories/${repo}/pullrequests/${pr}/comments`,
      async (url) => {
        const page = (await (await request("GET", url)).json()) as Page<BitbucketComment>;
        return { items: page.values, next: page.next };
      },
    );
    return all.filter((comment) => comment.deleted !== true);
  }

  const toComment = (comment: BitbucketComment, replies = 0): ScmComment => ({
    id: String(comment.id),
    body: comment.content.raw,
    ...(comment.inline !== undefined ? { path: comment.inline.path } : {}),
    ...(typeof comment.inline?.to === "number" ? { line: comment.inline.to } : {}),
    ...(comment.user?.uuid !== undefined ? { authorId: comment.user.uuid } : {}),
    ...(replies > 0 ? { replies } : {}),
    ...(comment.resolution !== undefined && comment.resolution !== null ? { resolved: true } : {}),
  });

  /**
   * GET /user answers 403 to repository and workspace access tokens, so for
   * those a draft comment (visible to nobody, deleted at once) names the bot.
   */
  async function resolveSelf(): Promise<string> {
    const commentsUrl = `${base}/repositories/${repo}/pullrequests/${pr}/comments`;
    try {
      const user = (await (await request("GET", `${base}/user`)).json()) as { uuid: string };
      return user.uuid;
    } catch (error) {
      if (!(error instanceof Error) || !/\b403\b|denied/.test(error.message)) throw error;
    }
    const draft = (await (
      await request("POST", commentsUrl, { content: { raw: "identity check" }, pending: true })
    ).json()) as BitbucketComment;
    await request("DELETE", `${commentsUrl}/${String(draft.id)}`);
    return draft.user?.uuid ?? "";
  }

  async function getText(): Promise<PullRequestText> {
    const meta = (await (
      await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}`)
    ).json()) as {
      title: string;
      description: string | null;
      links?: { html?: { href?: string } };
    };
    return { title: meta.title, body: meta.description ?? "", url: meta.links?.html?.href };
  }

  async function resolveSource(): Promise<{ sha: string; branch: string | undefined }> {
    if (source === undefined) {
      const meta = (await (
        await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}`)
      ).json()) as { source: { commit: { hash: string }; branch?: { name?: string } } };
      source = { sha: meta.source.commit.hash, branch: meta.source.branch?.name };
    }
    return source;
  }

  async function resolveSourceSha(): Promise<string> {
    return (await resolveSource()).sha;
  }

  function currentUserId(): Promise<string> {
    self ??= resolveSelf();
    return self;
  }

  return {
    // Bitbucket prints HTML comments as text and has no one-click suggestions
    hidesHtmlComments: false,
    suggestionFence: "",
    currentUserId,
    fileUrl(file: string, branch: string): string {
      return `https://bitbucket.org/${repo}/src/${encodeURIComponent(branch)}/${encodeURI(file)}`;
    },
    async listInlineComments(): Promise<ScmComment[]> {
      const all = await listComments();
      const replies = new Map<number, number>();
      for (const comment of all) {
        if (comment.parent !== undefined) {
          replies.set(comment.parent.id, (replies.get(comment.parent.id) ?? 0) + 1);
        }
      }
      return all
        .filter((c) => c.inline !== undefined && c.parent === undefined)
        .map((c) => toComment(c, replies.get(c.id)));
    },
    async createInlineComment(comment: NewInlineComment): Promise<string> {
      const created = (await (
        await request("POST", `${base}/repositories/${repo}/pullrequests/${pr}/comments`, {
          content: { raw: comment.body },
          inline: { path: comment.path, to: comment.line },
        })
      ).json()) as BitbucketComment;
      return String(created.id);
    },
    async listTasks(): Promise<ScmTask[]> {
      const all = await collectAllPages(
        `${base}/repositories/${repo}/pullrequests/${pr}/tasks`,
        async (url) => {
          const page = (await (await request("GET", url)).json()) as Page<BitbucketTask>;
          return { items: page.values, next: page.next };
        },
      );
      return all.map((task) => ({
        id: String(task.id),
        content: task.content.raw,
        ...(task.comment !== undefined ? { commentId: String(task.comment.id) } : {}),
        resolved: task.state === "RESOLVED",
        ...(task.resolved_by?.uuid !== undefined ? { resolvedBy: task.resolved_by.uuid } : {}),
      }));
    },
    async createTask(content: string, commentId: string): Promise<void> {
      await request("POST", `${base}/repositories/${repo}/pullrequests/${pr}/tasks`, {
        content: { raw: content },
        comment: { id: Number(commentId) },
      });
    },
    async resolveTask(id: string): Promise<void> {
      await request("PUT", `${base}/repositories/${repo}/pullrequests/${pr}/tasks/${id}`, {
        state: "RESOLVED",
      });
    },
    async updateComment(id: string, body: string): Promise<void> {
      await request("PUT", `${base}/repositories/${repo}/pullrequests/${pr}/comments/${id}`, {
        content: { raw: body },
      });
    },
    async deleteComment(id: string): Promise<void> {
      await request("DELETE", `${base}/repositories/${repo}/pullrequests/${pr}/comments/${id}`);
    },
    async resolveComment(id: string): Promise<void> {
      await request(
        "POST",
        `${base}/repositories/${repo}/pullrequests/${pr}/comments/${id}/resolve`,
      );
    },
    async listSummaryComments(): Promise<ScmComment[]> {
      return (await listComments()).filter((c) => c.inline === undefined).map((c) => toComment(c));
    },
    async createSummaryComment(body: string): Promise<void> {
      await request("POST", `${base}/repositories/${repo}/pullrequests/${pr}/comments`, {
        content: { raw: body },
      });
    },
    async updateSummaryComment(id: string, body: string): Promise<void> {
      await request("PUT", `${base}/repositories/${repo}/pullrequests/${pr}/comments/${id}`, {
        content: { raw: body },
      });
    },
    async postStatus(state: StatusState, description: string, name?: string): Promise<void> {
      const { sha, branch } = await resolveSource();
      // the real API answers 400 without an absolute url; refname ties the status to the PR
      await request("POST", `${base}/repositories/${repo}/commit/${sha}/statuses/build`, {
        state: STATUS_STATES[state],
        // the key is the status identity across runs; readers see only the name
        key: "delta-peacock",
        name: name ?? DEFAULT_DISPLAY_NAME,
        url: statusUrl,
        description,
        ...(branch !== undefined ? { refname: branch } : {}),
      });
    },
    async publishInsights(report: InsightReport): Promise<void> {
      const sha = await resolveSourceSha();
      const reportUrl = `${base}/repositories/${repo}/commit/${sha}/reports/delta-peacock`;
      await request("PUT", reportUrl, {
        title: report.title,
        details: report.details,
        report_type: "BUG",
        result: report.result,
        data: report.counts.map((count) => ({
          title: count.label,
          type: "NUMBER",
          value: count.value,
        })),
      });
      // the bulk endpoint upserts by external_id, one hundred at a time
      for (let start = 0; start < report.annotations.length; start += 100) {
        await request(
          "POST",
          `${reportUrl}/annotations`,
          report.annotations.slice(start, start + 100).map((annotation) => ({
            external_id: annotation.externalId,
            title: annotation.title,
            annotation_type: "CODE_SMELL",
            summary: annotation.summary,
            severity: annotation.severity,
            path: annotation.path,
            ...(annotation.line !== undefined ? { line: annotation.line } : {}),
            ...(annotation.link !== undefined ? { link: annotation.link } : {}),
          })),
        );
      }
    },
    async listCommentSignals(): Promise<CommentSignal[]> {
      // Bitbucket exposes no comment reactions; replies are the whole signal
      const all = await listComments();
      const me = await currentUserId();
      const repliesTo = new Map<number, string[]>();
      for (const comment of all) {
        if (comment.parent === undefined) continue;
        const list = repliesTo.get(comment.parent.id) ?? [];
        list.push(comment.content.raw);
        repliesTo.set(comment.parent.id, list);
      }
      return all
        .filter((comment) => comment.parent === undefined)
        .map((comment) => ({
          body: comment.content.raw,
          ...(comment.inline !== undefined ? { path: comment.inline.path } : {}),
          ...(typeof comment.inline?.to === "number" ? { line: comment.inline.to } : {}),
          own: comment.user?.uuid === me,
          reactions: { up: 0, down: 0 },
          replies: repliesTo.get(comment.id) ?? [],
        }));
    },
    async getPullRequestAuthor(): Promise<string> {
      const meta = (await (
        await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}`)
      ).json()) as { author?: { nickname?: string } };
      return meta.author?.nickname ?? "";
    },
    async getPullRequestText(): Promise<PullRequestText> {
      return getText();
    },
    async updatePullRequestText(text: { title?: string; body: string }): Promise<void> {
      // Bitbucket's update endpoint requires a title, so keep the current one
      const title = text.title ?? (await getText()).title;
      await request("PUT", `${base}/repositories/${repo}/pullrequests/${pr}`, {
        description: text.body,
        title,
      });
    },
    async fetchPullRequestDiff(): Promise<string> {
      const response = await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}/diff`);
      return response.text();
    },
  };
}
