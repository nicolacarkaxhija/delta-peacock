import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  reactions?: { "+1"?: number; "-1"?: number };
}

export interface WriteRecord {
  method: string;
  url: string;
}

export interface FakeGitHub {
  baseUrl: string;
  reviewComments: FakeComment[];
  issueComments: FakeComment[];
  statuses: { state: string; description: string; context: string; sha: string }[];
  /** Every non-GET request the server ever saw; dry-run asserts this stays empty. */
  writes: WriteRecord[];
  prText: { title: string; body: string };
  close(): Promise<void>;
}

const PER_PAGE = 2; // deliberately tiny so adapters must paginate

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function paginated(items: FakeComment[], url: URL): FakeComment[] {
  const page = Number(url.searchParams.get("page") ?? "1");
  return items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

/** A request-asserting fake of the GitHub REST surface the adapter uses. */
export async function startFakeGitHub(): Promise<FakeGitHub> {
  let nextId = 1;
  const state = {
    reviewComments: [] as FakeComment[],
    issueComments: [] as FakeComment[],
    statuses: [] as FakeGitHub["statuses"],
    writes: [] as WriteRecord[],
    prText: { title: "original title", body: "author prose" },
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method !== "GET") state.writes.push({ method, url: url.pathname });

      const auth = request.headers.authorization;
      if (auth !== "Bearer test-token" && auth !== "Bearer rate-limited") {
        send(response, 401, { message: "Bad credentials" });
        return;
      }
      if (auth === "Bearer rate-limited") {
        response.writeHead(403, {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
        });
        response.end(JSON.stringify({ message: "rate limited" }));
        return;
      }

      const path = url.pathname;
      const pullMeta = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/;
      const reviewComments = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/;
      const reviewComment = /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)$/;
      const issueComments = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/;
      const issueComment = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/;
      const statuses = /^\/repos\/[^/]+\/[^/]+\/statuses\/(.+)$/;

      if (method === "GET" && pullMeta.test(path)) {
        if (String(request.headers.accept).includes("diff")) {
          response.writeHead(200, { "content-type": "application/vnd.github.diff" });
          response.end("diff --git a/api.js b/api.js\n+from the github api diff\n");
        } else {
          send(response, 200, {
            head: { sha: "headsha1234567" },
            title: state.prText.title,
            body: state.prText.body,
            user: { login: "octocat" },
          });
        }
      } else if (method === "PATCH" && pullMeta.test(path)) {
        const body = await readBody(request);
        if (typeof body["body"] === "string") state.prText.body = body["body"];
        if (typeof body["title"] === "string") state.prText.title = body["title"];
        send(response, 200, state.prText);
      } else if (method === "GET" && reviewComments.test(path)) {
        send(response, 200, paginated(state.reviewComments, url));
      } else if (method === "POST" && reviewComments.test(path)) {
        const body = await readBody(request);
        state.reviewComments.push({
          id: nextId++,
          body: body["body"] as string,
          path: body["path"] as string,
          line: body["line"] as number,
        });
        send(response, 201, state.reviewComments.at(-1));
      } else if (reviewComment.test(path) && (method === "PATCH" || method === "DELETE")) {
        const id = Number(reviewComment.exec(path)?.[1]);
        const index = state.reviewComments.findIndex((comment) => comment.id === id);
        if (index === -1) {
          send(response, 404, { message: "not found" });
        } else if (method === "DELETE") {
          state.reviewComments.splice(index, 1);
          send(response, 204);
        } else {
          const body = await readBody(request);
          const target = state.reviewComments[index];
          if (target) target.body = body["body"] as string;
          send(response, 200, target);
        }
      } else if (method === "GET" && issueComments.test(path)) {
        send(response, 200, paginated(state.issueComments, url));
      } else if (method === "POST" && issueComments.test(path)) {
        const body = await readBody(request);
        state.issueComments.push({ id: nextId++, body: body["body"] as string });
        send(response, 201, state.issueComments.at(-1));
      } else if (method === "PATCH" && issueComment.test(path)) {
        const id = Number(issueComment.exec(path)?.[1]);
        const target = state.issueComments.find((comment) => comment.id === id);
        if (target === undefined) {
          send(response, 404, { message: "not found" });
        } else {
          const body = await readBody(request);
          target.body = body["body"] as string;
          send(response, 200, target);
        }
      } else if (method === "POST" && statuses.test(path)) {
        const body = await readBody(request);
        state.statuses.push({
          state: body["state"] as string,
          description: body["description"] as string,
          context: body["context"] as string,
          sha: statuses.exec(path)?.[1] ?? "",
        });
        send(response, 201, state.statuses.at(-1));
      } else {
        send(response, 404, { message: `no route for ${method} ${path}` });
      }
    })().catch(() => {
      send(response, 500, { message: "fake server error" });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    reviewComments: state.reviewComments,
    issueComments: state.issueComments,
    statuses: state.statuses,
    writes: state.writes,
    prText: state.prText,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
