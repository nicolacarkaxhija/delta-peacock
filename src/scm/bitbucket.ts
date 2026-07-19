import { ToolError } from "../errors.js";
import type {
  CommentSignal,
  InsightReport,
  NewInlineComment,
  PullRequestText,
  ScmComment,
  ScmPort,
  StatusState,
} from "./port.js";

export interface BitbucketPortOptions {
  /** workspace/repo */
  repository: string;
  pullRequest: number;
  token: string;
  /** Defaults to api.bitbucket.org/2.0; tests override it. */
  baseUrl?: string;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface BitbucketComment {
  id: number;
  content: { raw: string };
  inline?: { path: string; to?: number | null };
  parent?: { id: number };
  deleted?: boolean;
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
  if (!SAFE_REPOSITORY.test(options.repository)) {
    throw new ToolError(
      `scm.repository must look like workspace/repo, got ${JSON.stringify(options.repository)}`,
    );
  }
  const base = (options.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/$/, "");
  const repo = options.repository;
  const pr = String(options.pullRequest);
  let sourceSha: string | undefined;

  async function request(method: string, url: string, body?: unknown): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      throw new ToolError("Bitbucket rejected the credentials; check BITBUCKET_TOKEN");
    }
    if (response.status === 403) {
      throw new ToolError("Bitbucket denied the request (403); the token may lack permissions");
    }
    if (response.status === 429) {
      throw new ToolError("Bitbucket rate limit exhausted; retry after the limit resets");
    }
    if (!response.ok) {
      throw new ToolError(`Bitbucket responded ${String(response.status)} to ${method} ${url}`);
    }
    return response;
  }

  async function listComments(): Promise<BitbucketComment[]> {
    const all: BitbucketComment[] = [];
    let url: string | undefined = `${base}/repositories/${repo}/pullrequests/${pr}/comments`;
    while (url !== undefined) {
      const page = (await (await request("GET", url)).json()) as Page<BitbucketComment>;
      all.push(...page.values);
      url = page.next;
    }
    return all.filter((comment) => comment.deleted !== true);
  }

  const toComment = (comment: BitbucketComment): ScmComment => ({
    id: String(comment.id),
    body: comment.content.raw,
    ...(comment.inline !== undefined ? { path: comment.inline.path } : {}),
    ...(typeof comment.inline?.to === "number" ? { line: comment.inline.to } : {}),
  });

  async function getText(): Promise<PullRequestText> {
    const meta = (await (
      await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}`)
    ).json()) as { title: string; description: string | null };
    return { title: meta.title, body: meta.description ?? "" };
  }

  async function resolveSourceSha(): Promise<string> {
    if (sourceSha === undefined) {
      const meta = (await (
        await request("GET", `${base}/repositories/${repo}/pullrequests/${pr}`)
      ).json()) as { source: { commit: { hash: string } } };
      sourceSha = meta.source.commit.hash;
    }
    return sourceSha;
  }

  return {
    async listInlineComments(): Promise<ScmComment[]> {
      return (await listComments()).filter((c) => c.inline !== undefined).map(toComment);
    },
    async createInlineComment(comment: NewInlineComment): Promise<void> {
      await request("POST", `${base}/repositories/${repo}/pullrequests/${pr}/comments`, {
        content: { raw: comment.body },
        inline: { path: comment.path, to: comment.line },
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
    async listSummaryComments(): Promise<ScmComment[]> {
      return (await listComments()).filter((c) => c.inline === undefined).map(toComment);
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
    async postStatus(state: StatusState, description: string): Promise<void> {
      const sha = await resolveSourceSha();
      await request("POST", `${base}/repositories/${repo}/commit/${sha}/statuses/build`, {
        state: STATUS_STATES[state],
        key: "delta-peacock",
        description,
      });
    },
    async publishInsights(report: InsightReport): Promise<void> {
      const sha = await resolveSourceSha();
      const reportUrl = `${base}/repositories/${repo}/commit/${sha}/reports/delta-peacock`;
      await request("PUT", reportUrl, {
        title: "delta-peacock review",
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
            line: annotation.line,
          })),
        );
      }
    },
    async listCommentSignals(): Promise<CommentSignal[]> {
      // Bitbucket exposes no comment reactions; replies are the whole signal
      const all = await listComments();
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
          reactions: { up: 0, down: 0 },
          replies: repliesTo.get(comment.id) ?? [],
        }));
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
