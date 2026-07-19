import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeBitbucketComment {
  id: number;
  content: { raw: string };
  inline?: { path: string; to: number };
  parent?: { id: number };
}

export interface FakeBitbucket {
  baseUrl: string;
  comments: FakeBitbucketComment[];
  statuses: { state: string; description: string; key: string; sha: string }[];
  writes: { method: string; url: string }[];
  /** Served by the PR diff endpoint. */
  diffText: string;
  prText: { title: string; body: string };
  close(): Promise<void>;
}

const PER_PAGE = 2;

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
  };
  const holder = { diffText: "" };

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

      if (method === "GET" && prMeta.test(path)) {
        send(response, 200, {
          source: { commit: { hash: "srcsha7890123" } },
          title: state.prText.title,
          description: state.prText.body,
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
        state.comments.push({
          id: nextId++,
          content: body["content"] as { raw: string },
          ...(body["inline"] !== undefined
            ? { inline: body["inline"] as { path: string; to: number } }
            : {}),
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
      } else if (method === "POST" && statusRoute.test(path)) {
        const body = await readBody(request);
        state.statuses.push({
          state: body["state"] as string,
          description: body["description"] as string,
          key: body["key"] as string,
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
