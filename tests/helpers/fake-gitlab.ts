import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakePosition {
  base_sha: string;
  head_sha: string;
  start_sha: string;
  position_type: string;
  new_path: string;
  new_line: number;
}

export interface FakeNote {
  id: number;
  body: string;
  system: boolean;
  position?: FakePosition;
}

export interface FakeGitLab {
  baseUrl: string;
  notes: FakeNote[];
  statuses: { state: string; description: string; name: string; sha: string }[];
  /** Every non-GET request the server ever saw; dry-run asserts this stays empty. */
  writes: { method: string; url: string }[];
  /** URL-encoded project ids the server was addressed with. */
  projects: string[];
  prText: { title: string; body: string };
  /** How many times MR metadata was fetched; adapters must cache it. */
  metaFetches: number;
  diffText: string;
  close(): Promise<void>;
}

const PER_PAGE = 2; // deliberately tiny so adapters must paginate

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

/** A request-asserting fake of the GitLab v4 REST surface the adapter uses. */
export async function startFakeGitLab(): Promise<FakeGitLab> {
  let nextId = 1;
  const state = {
    notes: [] as FakeNote[],
    statuses: [] as FakeGitLab["statuses"],
    writes: [] as FakeGitLab["writes"],
    projects: [] as string[],
    prText: { title: "original title", body: "author prose" },
    metaFetches: 0,
    diffText: "diff --git a/api.js b/api.js\n+from the gitlab api diff\n",
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method !== "GET") state.writes.push({ method, url: url.pathname });

      const token = request.headers["private-token"];
      if (token === "forbidden") {
        send(response, 403, { message: "insufficient scope" });
        return;
      }
      if (token === "rate-limited") {
        send(response, 429, { message: "too many requests" });
        return;
      }
      if (token === "teapot") {
        send(response, 418, { message: "teapot" });
        return;
      }
      if (token !== "test-token") {
        send(response, 401, { message: "401 Unauthorized" });
        return;
      }

      // paths arrive with the project id still percent-encoded
      const path = url.pathname;
      const project = /^\/api\/v4\/projects\/([^/]+)\//.exec(path)?.[1];
      if (project !== undefined && !state.projects.includes(project)) {
        state.projects.push(project);
      }

      const mrMeta = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+$/;
      const rawDiffs = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/raw_diffs$/;
      const notes = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/notes$/;
      const note = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/notes\/(\d+)$/;
      const discussions = /^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/discussions$/;
      const statuses = /^\/api\/v4\/projects\/[^/]+\/statuses\/(.+)$/;

      if (method === "GET" && mrMeta.test(path)) {
        state.metaFetches += 1;
        send(response, 200, {
          sha: "headsha1234567",
          title: state.prText.title,
          description: state.prText.body,
          web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
          author: { username: "gluser" },
          diff_refs: {
            base_sha: "basesha1234567",
            head_sha: "headsha1234567",
            start_sha: "startsha123456",
          },
        });
      } else if (method === "PUT" && mrMeta.test(path)) {
        const body = await readBody(request);
        if (typeof body["description"] === "string") state.prText.body = body["description"];
        if (typeof body["title"] === "string") state.prText.title = body["title"];
        send(response, 200, state.prText);
      } else if (method === "GET" && rawDiffs.test(path)) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(state.diffText);
      } else if (method === "GET" && notes.test(path)) {
        const page = Number(url.searchParams.get("page") ?? "1");
        send(response, 200, state.notes.slice((page - 1) * PER_PAGE, page * PER_PAGE));
      } else if (method === "POST" && notes.test(path)) {
        const body = await readBody(request);
        state.notes.push({ id: nextId++, body: body["body"] as string, system: false });
        send(response, 201, state.notes.at(-1));
      } else if (method === "POST" && discussions.test(path)) {
        const body = await readBody(request);
        state.notes.push({
          id: nextId++,
          body: body["body"] as string,
          system: false,
          position: body["position"] as FakePosition,
        });
        send(response, 201, { id: "d1", notes: [state.notes.at(-1)] });
      } else if (note.test(path) && (method === "PUT" || method === "DELETE")) {
        const id = Number(note.exec(path)?.[1]);
        const index = state.notes.findIndex((candidate) => candidate.id === id);
        if (index === -1) {
          send(response, 404, { message: "not found" });
        } else if (method === "DELETE") {
          state.notes.splice(index, 1);
          send(response, 204);
        } else {
          const body = await readBody(request);
          const target = state.notes[index];
          if (target) target.body = body["body"] as string;
          send(response, 200, target);
        }
      } else if (method === "POST" && statuses.test(path)) {
        const body = await readBody(request);
        state.statuses.push({
          state: body["state"] as string,
          description: body["description"] as string,
          name: body["name"] as string,
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
    baseUrl: `http://127.0.0.1:${String(port)}/api/v4`,
    notes: state.notes,
    statuses: state.statuses,
    writes: state.writes,
    projects: state.projects,
    prText: state.prText,
    get metaFetches() {
      return state.metaFetches;
    },
    get diffText() {
      return state.diffText;
    },
    set diffText(value: string) {
      state.diffText = value;
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
