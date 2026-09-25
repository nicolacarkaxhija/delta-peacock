import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeBitbucketComment {
  id: number;
  content: { raw: string };
  inline?: { path: string; to: number };
  parent?: { id: number };
  user?: { uuid: string };
  pending?: boolean;
}

/** The fake token's own user, like a repository access token's bot. */
export const BOT_UUID = "{bot-0000}";

export interface FakeInsightAnnotation {
  external_id: string;
  title: string;
  annotation_type: string;
  summary: string;
  severity: string;
  path: string;
  line: number;
  link?: string;
}

export interface FakeBitbucket {
  baseUrl: string;
  comments: FakeBitbucketComment[];
  statuses: { state: string; description: string; key: string; name: string; sha: string }[];
  writes: { method: string; url: string }[];
  /** "forbidden" mirrors an access token (GET /user answers 403); "ok" an API token. */
  userEndpoint: "forbidden" | "ok";
  /** Pending draft comments ever created. */
  readonly drafts: number;
  /** Served by the PR diff endpoint. */
  diffText: string;
  prText: { title: string; body: string };
  insightReport: Record<string, unknown> | undefined;
  /** The last accepted build status body, as sent. */
  readonly lastStatusBody: Record<string, unknown> | undefined;
  insightAnnotations: FakeInsightAnnotation[];
  /** Simulates a workspace with Code Insights switched off (404s). */
  insightsDisabled: boolean;
  close(): Promise<void>;
}

const PER_PAGE = 2;

const BUILD_STATES = ["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"];

/** The field rules api.bitbucket.org enforces on a build status, as observed on 2026-09-25. */
export function buildStatusFieldErrors(body: Record<string, unknown>): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  const { key, state, url } = body;
  if (typeof key !== "string" || key === "") fields["key"] = ["This field is required."];
  if (typeof state !== "string" || !BUILD_STATES.includes(state)) {
    fields["state"] = [`"state" must be one of {'${BUILD_STATES.join("', '")}'}`];
  }
  if (url === undefined || url === "") {
    fields["url"] = ["This field is required."];
  } else if (typeof url !== "string" || !/^https?:\/\/[^/\s]+/.test(url)) {
    fields["url"] = ["Enter a valid URL."];
  }
  return fields;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function send(response: ServerResponse, status: number, body?: unknown, raw = false): void {
  response.writeHead(status, { "content-type": raw ? "text/plain" : "application/json" });
  if (raw) {
    response.end(typeof body === "string" ? body : "");
  } else {
    response.end(body === undefined ? "" : JSON.stringify(body));
  }
}

export async function startFakeBitbucket(): Promise<FakeBitbucket> {
  let nextId = 1;
  const state = {
    comments: [] as FakeBitbucketComment[],
    statuses: [] as FakeBitbucket["statuses"],
    writes: [] as { method: string; url: string }[],
    prText: { title: "original title", body: "author prose" },
    insightAnnotations: [] as FakeInsightAnnotation[],
    lastStatusBody: undefined as Record<string, unknown> | undefined,
  };
  const holder = {
    diffText: "",
    drafts: 0,
    userEndpoint: "forbidden" as "forbidden" | "ok",
    insightsDisabled: false,
    insightReport: undefined as Record<string, unknown> | undefined,
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method !== "GET") state.writes.push({ method, url: url.pathname });

      const auth = request.headers.authorization;
      if (auth === "Bearer forbidden") {
        send(response, 403, { error: { message: "forbidden" } });
        return;
      }
      if (auth === "Bearer rate-limited") {
        send(response, 429, { error: { message: "rate limited" } });
        return;
      }
      if (auth === "Bearer teapot") {
        send(response, 418, { error: { message: "teapot" } });
        return;
      }
      if (auth !== "Bearer test-token") {
        send(response, 401, { error: { message: "unauthorized" } });
        return;
      }

      const path = url.pathname;
      const prMeta = /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+$/;
      const prDiff = /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/diff$/;
      const commentsRoute = /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/comments$/;
      const commentRoute = /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/comments\/(\d+)$/;
      const statusRoute = /^\/repositories\/[^/]+\/[^/]+\/commit\/([^/]+)\/statuses\/build$/;
      const reportRoute = /^\/repositories\/[^/]+\/[^/]+\/commit\/[^/]+\/reports\/([^/]+)$/;
      const annotationsRoute =
        /^\/repositories\/[^/]+\/[^/]+\/commit\/[^/]+\/reports\/[^/]+\/annotations$/;

      if (method === "GET" && path === "/user") {
        if (holder.userEndpoint === "ok") send(response, 200, { uuid: BOT_UUID });
        else
          send(response, 403, {
            type: "error",
            error: { message: "This API is not accessible by this authentication mechanism" },
          });
      } else if (method === "GET" && prMeta.test(path)) {
        send(response, 200, {
          source: { commit: { hash: "srcsha7890123" }, branch: { name: "feature/widgets" } },
          title: state.prText.title,
          description: state.prText.body,
          author: { nickname: "bbuser" },
        });
      } else if (method === "PUT" && prMeta.test(path)) {
        const body = await readBody(request);
        if (typeof body["description"] === "string") state.prText.body = body["description"];
        if (typeof body["title"] === "string") state.prText.title = body["title"];
        send(response, 200, state.prText);
      } else if (method === "GET" && prDiff.test(path)) {
        send(response, 200, holder.diffText, true);
      } else if (method === "GET" && commentsRoute.test(path)) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const values = state.comments.slice((page - 1) * PER_PAGE, page * PER_PAGE);
        const hasMore = state.comments.length > page * PER_PAGE;
        send(response, 200, {
          values,
          ...(hasMore
            ? { next: `http://127.0.0.1:${String(port)}${path}?page=${String(page + 1)}` }
            : {}),
        });
      } else if (method === "POST" && commentsRoute.test(path)) {
        const body = await readBody(request);
        if (body["pending"] === true) holder.drafts += 1;
        state.comments.push({
          id: nextId++,
          content: body["content"] as { raw: string },
          ...(body["inline"] !== undefined
            ? { inline: body["inline"] as { path: string; to: number } }
            : {}),
          user: { uuid: BOT_UUID },
          ...(body["pending"] === true ? { pending: true } : {}),
        });
        send(response, 201, state.comments.at(-1));
      } else if (commentRoute.test(path) && (method === "PUT" || method === "DELETE")) {
        const id = Number(commentRoute.exec(path)?.[1]);
        const index = state.comments.findIndex((comment) => comment.id === id);
        if (index === -1) {
          send(response, 404, { error: { message: "not found" } });
        } else if (method === "DELETE") {
          state.comments.splice(index, 1);
          send(response, 204);
        } else {
          const body = await readBody(request);
          const target = state.comments[index];
          if (target) target.content = body["content"] as { raw: string };
          send(response, 200, target);
        }
      } else if (method === "PUT" && reportRoute.test(path)) {
        if (holder.insightsDisabled) {
          send(response, 404, { error: { message: "Code Insights is not enabled" } });
        } else {
          holder.insightReport = await readBody(request);
          send(response, 200, holder.insightReport);
        }
      } else if (method === "POST" && annotationsRoute.test(path)) {
        if (holder.insightsDisabled) {
          send(response, 404, { error: { message: "Code Insights is not enabled" } });
        } else {
          const body = (await readBody(request)) as unknown as FakeInsightAnnotation[];
          for (const annotation of body) {
            const at = state.insightAnnotations.findIndex(
              (existing) => existing.external_id === annotation.external_id,
            );
            if (at === -1) state.insightAnnotations.push(annotation);
            else state.insightAnnotations[at] = annotation;
          }
          send(response, 200, body);
        }
      } else if (method === "POST" && statusRoute.test(path)) {
        const body = await readBody(request);
        const fields = buildStatusFieldErrors(body);
        if (Object.keys(fields).length > 0) {
          send(response, 400, { type: "error", error: { message: "Bad request", fields } });
          return;
        }
        state.lastStatusBody = body;
        state.statuses.push({
          state: body["state"] as string,
          description: body["description"] as string,
          key: body["key"] as string,
          name: body["name"] as string,
          sha: statusRoute.exec(path)?.[1] ?? "",
        });
        send(response, 201, state.statuses.at(-1));
      } else {
        send(response, 404, { error: { message: `no route for ${method} ${path}` } });
      }
    })().catch(() => {
      send(response, 500, { error: { message: "fake server error" } });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    comments: state.comments,
    statuses: state.statuses,
    writes: state.writes,
    prText: state.prText,
    insightAnnotations: state.insightAnnotations,
    get insightReport() {
      return holder.insightReport;
    },
    get lastStatusBody() {
      return state.lastStatusBody;
    },
    get insightsDisabled() {
      return holder.insightsDisabled;
    },
    set insightsDisabled(value: boolean) {
      holder.insightsDisabled = value;
    },
    get drafts() {
      return holder.drafts;
    },
    get userEndpoint() {
      return holder.userEndpoint;
    },
    set userEndpoint(value: "forbidden" | "ok") {
      holder.userEndpoint = value;
    },
    get diffText() {
      return holder.diffText;
    },
    set diffText(value: string) {
      holder.diffText = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
