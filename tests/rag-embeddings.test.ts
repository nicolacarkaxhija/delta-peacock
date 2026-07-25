import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { embedMany } from "ai";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import {
  buildEmbeddingPort,
  cosine,
  openAiishEmbedding,
  bedrockEmbedding,
  type EmbeddingPort,
} from "../src/context/embedding.js";
import { createRagEmbeddingsProvider } from "../src/context/rag.js";
import { ToolError } from "../src/errors.js";
import { mergeBaseDiff } from "../src/git/diff.js";
import { runCli } from "../src/index.js";
import type { ModelPort, ModelRequest } from "../src/model/port.js";
import { commitAll, git, makeRepo, write } from "./helpers/git.js";

const GUIDELINE =
  "---\nid: no-breaking-signature-change\nseverity: MAJOR\n---\n# No breaking changes\n\nKeep callers working.\n";

/** Vectors with meaning: dimension zero is "greet", dimension one is noise. */
function keywordPort(): { calls: string[][]; port: EmbeddingPort } {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      embed(texts) {
        calls.push([...texts]);
        return Promise.resolve({
          vectors: texts.map((text) => [
            text.includes("greet") ? 1 : 0,
            text.includes("unrelated") ? 1 : 0,
          ]),
          tokens: texts.length,
        });
      },
    },
  };
}

function makeCrossFileRepo(): { repo: string; diff: string } {
  const repo = makeRepo();
  write(repo, "guidelines/no-breaking-signature-change.md", GUIDELINE);
  write(
    repo,
    "src/caller.js",
    "const { greet } = require('./app.js');\nmodule.exports = () => greet('x');\n",
  );
  write(repo, "src/other.js", "// unrelated helper\nmodule.exports = () => 42;\n");
  commitAll(repo, "base");
  git(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/app.js", "function greet(name, formal) {\n  return name;\n}\n");
  commitAll(repo, "change greet");
  return { repo, diff: mergeBaseDiff(repo, "main") };
}

describe("configuration of the retrieval backend", () => {
  it("requires a model for the embeddings backend", () => {
    expect(() =>
      loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings" } }),
    ).toThrow(/context\.rag\.model/);
  });

  it("requires a base url for openai-compatible embeddings", () => {
    expect(() =>
      loadConfig({
        root: makeRepo(),
        env: {
          DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
          DELTA_PEACOCK_CONTEXT_RAG_MODEL: "nomic-embed-text",
        },
      }),
    ).toThrow(/baseUrl/);
  });

  it("tfidf stays the default and needs nothing", () => {
    const config = loadConfig({ root: makeRepo() });
    expect(config.context.rag.backend).toBe("tfidf");
  });

  it("bedrock embeddings demand AWS credentials at build time", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_PROVIDER: "bedrock",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "amazon.titan-embed-text-v2:0",
      },
    });
    expect(() => buildEmbeddingPort(config, {})).toThrow(ToolError);
  });
});

describe("adapter construction branches", () => {
  it("bedrock builds with the full option set (session token, base url)", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_PROVIDER: "bedrock",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "amazon.titan-embed-text-v2:0",
        DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: "http://127.0.0.1:1/bedrock",
      },
    });
    const port = buildEmbeddingPort(config, {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session",
    });
    expect(typeof port.embed).toBe("function");
  });

  it("bedrock builds with the minimal option set", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_PROVIDER: "bedrock",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "amazon.titan-embed-text-v2:0",
      },
    });
    const port = buildEmbeddingPort(config, {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(typeof port.embed).toBe("function");
  });

  it("pricing wraps only when a rate is configured, approximating missing tokens", async () => {
    const { priceEmbeddings } = await import("../src/context/embedding.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-price-")), "spend.json");
    const inner: EmbeddingPort = {
      embed: (texts) => Promise.resolve({ vectors: texts.map(() => [1]) }),
    };
    const free = loadConfig({ root: makeRepo() });
    expect(priceEmbeddings(inner, free, () => new Date())).toBe(inner);

    const priced = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_COST_RATE_EMBED_PER_1M: "0.02",
        DELTA_PEACOCK_COST_COUNTER_PATH: counter,
      },
    });
    const reply = await priceEmbeddings(inner, priced, () => new Date()).embed(["abcdefgh"]);
    expect(reply.vectors).toHaveLength(1); // tokens approximated from text length
    expect(existsSync(counter)).toBe(true);
  });

  it("builds the real embedding adapter behind the context factory", async () => {
    const { buildContextProvider } = await import("../src/context/build.js");
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CONTEXT_PROVIDER: "rag",
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "text-embedding-3-small",
        DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: "http://127.0.0.1:1/v1",
      },
    });
    // construction only; nothing is embedded until systemContext runs
    const provider = buildContextProvider(config, { env: { OPENAI_API_KEY: "k" } });
    expect(provider.name).toBe("rag");
  });
});

describe("guards and small parts", () => {
  it("refuses to build without a model even off the schema path", () => {
    expect(() => buildEmbeddingPort(loadConfig({ root: makeRepo() }), {})).toThrow(
      /context\.rag\.model/,
    );
  });

  it("constructs the openai adapter with the local-host key fallback", () => {
    const config = loadConfig({
      root: makeRepo(),
      env: {
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "nomic-embed-text",
        DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: "http://127.0.0.1:11434/v1",
      },
    });
    // no OPENAI_API_KEY: local hosts such as Ollama do not need one
    expect(typeof buildEmbeddingPort(config, {}).embed).toBe("function");
  });

  it("validates cached chunk shapes field by field", async () => {
    const { isEmbeddedChunk } = await import("../src/context/rag.js");
    const good = { file: "a.js", startLine: 1, text: "t", vector: [0.1, 0.2] };
    expect(isEmbeddedChunk(good)).toBe(true);
    expect(isEmbeddedChunk(null)).toBe(false);
    expect(isEmbeddedChunk("chunk")).toBe(false);
    expect(isEmbeddedChunk({ ...good, file: 7 })).toBe(false);
    expect(isEmbeddedChunk({ ...good, startLine: "1" })).toBe(false);
    expect(isEmbeddedChunk({ ...good, text: null })).toBe(false);
    expect(isEmbeddedChunk({ ...good, vector: "not" })).toBe(false);
    expect(isEmbeddedChunk({ ...good, vector: [0.1, "x"] })).toBe(false);
  });

  it("cosine tolerates a sparse vector entry", () => {
    const sparse: number[] = [1];
    sparse[2] = 5; // index 1 is a hole
    expect(cosine(sparse, [1, 1, 1])).toBeGreaterThan(0);
    expect(cosine([1, 1, 1], sparse)).toBeGreaterThan(0);
  });

  it("composes a sync and an async provider transparently", async () => {
    const { composeProviders } = await import("../src/context/port.js");
    const composed = composeProviders([
      { name: "sync", systemContext: () => "sync part" },
      { name: "later", systemContext: () => Promise.resolve("async part") },
    ]);
    const text = await composed.systemContext({ cwd: ".", diff: "", changedFiles: [] });
    expect(text).toBe("sync part\n\nasync part");
  });
});

describe("embedding retrieval", () => {
  it("ranks the semantically related chunk above noise", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const { port } = keywordPort();
    const provider = createRagEmbeddingsProvider({ port, embeddingKey: "test/fake" });
    const text = await provider.systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/app.js"],
    });
    expect(text).toContain("embedding retrieval");
    expect(text).toContain("src/caller.js");
    expect(text).not.toContain("src/app.js:"); // changed files never retrieve themselves
  });

  it("re-embeds only the changed file when the tree moves, reusing the rest", async () => {
    const repo = makeRepo();
    write(repo, "guidelines/g.md", GUIDELINE);
    write(repo, "src/a.js", "function alpha() {\n  return greet('a');\n}\n");
    write(repo, "src/b.js", "function beta() {\n  return 'unrelated' + 2;\n}\n");
    write(repo, "src/c.js", "function gamma() {\n  return 3;\n}\n");
    commitAll(repo, "base");
    const input = { cwd: repo, diff: "+greet('x')\n", changedFiles: [] as string[] };

    const first = keywordPort();
    await createRagEmbeddingsProvider({ port: first.port, embeddingKey: "k" }).systemContext(input);
    const embeddedFirst = first.calls[0]?.length ?? 0; // all corpus chunks
    expect(embeddedFirst).toBeGreaterThanOrEqual(3);

    // change one file's content and re-commit: the tree key moves
    write(repo, "src/b.js", "function beta() {\n  return 'changed body' + 99;\n}\n");
    commitAll(repo, "touch b");

    const second = keywordPort();
    const provider = createRagEmbeddingsProvider({ port: second.port, embeddingKey: "k" });
    await provider.systemContext(input);
    // the corpus re-embed call carries only the changed chunk, not the whole tree
    expect(second.calls[0]?.length).toBe(1);
    expect(second.calls[0]?.[0]).toContain("changed body");
    expect(provider.notices?.().some((n) => n.includes("reused") && n.includes("embedded 1"))).toBe(
      true,
    );
  });

  it("reuses cached vectors and re-embeds only the query", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const input = { cwd: repo, diff, changedFiles: ["src/app.js"] };
    const first = keywordPort();
    await createRagEmbeddingsProvider({
      port: first.port,
      embeddingKey: "test/fake",
    }).systemContext(input);
    expect(first.calls).toHaveLength(2); // corpus, then query

    const second = keywordPort();
    await createRagEmbeddingsProvider({
      port: second.port,
      embeddingKey: "test/fake",
    }).systemContext(input);
    expect(second.calls).toHaveLength(1); // query only

    const otherModel = keywordPort();
    await createRagEmbeddingsProvider({
      port: otherModel.port,
      embeddingKey: "test/other-model",
    }).systemContext(input);
    expect(otherModel.calls).toHaveLength(2); // key mismatch forces a rebuild
  });

  it("writes no cache without a resolvable tree", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const repo = mkdtempSync(path.join(tmpdir(), "dp-notree-")); // not a git repository
    write(repo, "src/caller.js", "greet('x');\n");
    const { port } = keywordPort();
    await createRagEmbeddingsProvider({ port, embeddingKey: "test/fake" }).systemContext({
      cwd: repo,
      diff: "+greet('y');",
      changedFiles: [],
    });
    expect(existsSync(path.join(repo, ".delta-peacock-cache", "rag-embeddings.json"))).toBe(false);
  });

  it("rebuilds when the cache file is unreadable", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const cacheDir = path.join(repo, ".delta-peacock-cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, "rag-embeddings.json"), "{not json");
    const { calls, port } = keywordPort();
    const provider = createRagEmbeddingsProvider({ port, embeddingKey: "test/fake" });
    const text = await provider.systemContext({ cwd: repo, diff, changedFiles: ["src/app.js"] });
    expect(text).toContain("src/caller.js");
    expect(calls).toHaveLength(2); // full rebuild
    expect(provider.notices?.()[0]).toContain("unreadable");
  });

  it("degrades at query time too, even with a healthy cache", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const input = { cwd: repo, diff, changedFiles: ["src/app.js"] };
    await createRagEmbeddingsProvider({
      port: keywordPort().port,
      embeddingKey: "test/fake",
    }).systemContext(input); // warms the cache
    let callCount = 0;
    const failingSecond: EmbeddingPort = {
      embed() {
        callCount += 1;
        return Promise.reject(new Error("query endpoint down"));
      },
    };
    const provider = createRagEmbeddingsProvider({
      port: failingSecond,
      embeddingKey: "test/fake",
    });
    const text = await provider.systemContext(input);
    expect(text).toBe("");
    expect(callCount).toBe(1); // only the query was attempted; chunks came from cache
    expect(provider.notices?.()[0]).toContain("query endpoint down");
  });

  it("rebuilds on a cache version bump", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const input = { cwd: repo, diff, changedFiles: ["src/app.js"] };
    await createRagEmbeddingsProvider({
      port: keywordPort().port,
      embeddingKey: "test/fake",
    }).systemContext(input);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const cachePath = path.join(repo, ".delta-peacock-cache", "rag-embeddings.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    writeFileSync(cachePath, JSON.stringify({ ...cached, version: 2 }));
    const rerun = keywordPort();
    await createRagEmbeddingsProvider({
      port: rerun.port,
      embeddingKey: "test/fake",
    }).systemContext(input);
    expect(rerun.calls).toHaveLength(2); // corpus re-embedded
  });

  it("stays silent when the backend returns no vectors at all", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const empty: EmbeddingPort = { embed: () => Promise.resolve({ vectors: [] }) };
    const provider = createRagEmbeddingsProvider({ port: empty, embeddingKey: "test/empty" });
    const text = await provider.systemContext({ cwd: repo, diff, changedFiles: ["src/app.js"] });
    expect(text).toBe("");
  });

  it("returns nothing when no chunk relates to the diff", async () => {
    const { repo } = makeCrossFileRepo();
    const { port } = keywordPort();
    const provider = createRagEmbeddingsProvider({ port, embeddingKey: "test/fake" });
    const text = await provider.systemContext({
      cwd: repo,
      diff: "+++ something entirely different\n+const x = 1;\n",
      changedFiles: ["src/app.js"],
    });
    expect(text).toBe("");
  });

  it("degrades to no retrieval with a notice when embeddings fail", async () => {
    const { repo, diff } = makeCrossFileRepo();
    const provider = createRagEmbeddingsProvider({
      port: { embed: () => Promise.reject(new Error("endpoint down")) },
      embeddingKey: "test/fake",
    });
    const text = await provider.systemContext({ cwd: repo, diff, changedFiles: ["src/app.js"] });
    expect(text).toBe("");
    expect(provider.notices?.()[0]).toContain("endpoint down");
  });

  it("cosine handles zero vectors and compares only the shared prefix", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    // same-model vectors always match in length; a mismatch compares the prefix
    expect(cosine([1, 0, 5], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("review pipeline with the embeddings backend", () => {
  it("feeds retrieved chunks into the prompt through the injected port", async () => {
    const { repo } = makeCrossFileRepo();
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: '{"findings": []}' });
      },
    };
    const { port } = keywordPort();
    const code = await runCli(["review"], {
      cwd: repo,
      env: {
        DELTA_PEACOCK_CONTEXT_PROVIDER: "rag",
        DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
        DELTA_PEACOCK_CONTEXT_RAG_MODEL: "fake-model",
        DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: "http://127.0.0.1:1/v1",
      },
      out: () => undefined,
      err: () => undefined,
      modelPort: model,
      embeddingPort: port,
    });
    expect(code).toBe(0);
    expect(requests[0]?.system).toContain("## Project context");
    expect(requests[0]?.system).toContain("src/caller.js");
  });
});

describe("embedding adapters at the HTTP boundary", () => {
  async function fakeOpenAiEmbeddings(omitUsage = false): Promise<{
    baseUrl: string;
    requests: { url: string; auth: string | undefined; body: Record<string, unknown> }[];
    close: () => Promise<void>;
  }> {
    const requests: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({
          url: request.url ?? "",
          auth: request.headers.authorization,
          body,
        });
        const input = body["input"] as string[];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: input.map((_, index) => ({
              object: "embedding",
              index,
              embedding: [index + 1, 0.5],
            })),
            model: body["model"],
            ...(omitUsage ? {} : { usage: { prompt_tokens: 7, total_tokens: 7 } }),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      requests,
      close: () =>
        new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    };
  }

  it("openai-compatible speaks the embeddings protocol", async () => {
    const fake = await fakeOpenAiEmbeddings();
    try {
      const model = openAiishEmbedding({
        baseUrl: fake.baseUrl,
        apiKey: "test-key",
        modelId: "text-embedding-3-small",
        fetch: (input, init) => globalThis.fetch(input, init), // the seam stays honored
      });
      const result = await embedMany({ model, values: ["alpha", "beta"] });
      expect(result.embeddings).toEqual([
        [1, 0.5],
        [2, 0.5],
      ]);
      const request = fake.requests[0];
      expect(request?.url).toContain("/embeddings");
      expect(request?.auth).toBe("Bearer test-key");
      expect(request?.body["model"]).toBe("text-embedding-3-small");
      expect(request?.body["input"]).toEqual(["alpha", "beta"]);
    } finally {
      await fake.close();
    }
  });

  it("bedrock signs the request with SigV4", async () => {
    const seen: { url: string; authorization: string }[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url:
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        authorization: headers.get("authorization") ?? "",
      });
      return Promise.resolve(
        new Response(JSON.stringify({ embedding: [0.1, 0.2], inputTextTokenCount: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const model = bedrockEmbedding({
      region: "eu-central-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
      modelId: "amazon.titan-embed-text-v2:0",
      fetch: fakeFetch,
    });
    const result = await embedMany({ model, values: ["alpha"] });
    expect(result.embeddings[0]).toEqual([0.1, 0.2]);
    expect(seen[0]?.url).toContain("titan-embed");
    expect(seen[0]?.authorization).toContain("AWS4-HMAC-SHA256");
  });

  it("prices billed tokens onto the spend counter", async () => {
    const fake = await fakeOpenAiEmbeddings();
    try {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const counter = path.join(mkdtempSync(path.join(tmpdir(), "dp-embed-")), "spend.json");
      const config = loadConfig({
        root: makeRepo(),
        env: {
          DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
          DELTA_PEACOCK_CONTEXT_RAG_MODEL: "text-embedding-3-small",
          DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_COST_RATE_EMBED_PER_1M: "0.02",
          DELTA_PEACOCK_COST_COUNTER_PATH: counter,
        },
      });
      const port = buildEmbeddingPort(config, { OPENAI_API_KEY: "test-key" });
      const reply = await port.embed(["alpha"]);
      expect(reply.tokens).toBe(7);
      expect(existsSync(counter)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("approximates tokens when the provider bills none, on the default counter", async () => {
    const fake = await fakeOpenAiEmbeddings(true);
    try {
      const config = loadConfig({
        root: makeRepo(),
        env: {
          DELTA_PEACOCK_CONTEXT_RAG_BACKEND: "embeddings",
          DELTA_PEACOCK_CONTEXT_RAG_MODEL: "text-embedding-3-small",
          DELTA_PEACOCK_CONTEXT_RAG_BASE_URL: fake.baseUrl,
          DELTA_PEACOCK_COST_RATE_EMBED_PER_1M: "0.02",
          // no counter path: the default home location takes the record
        },
      });
      const port = buildEmbeddingPort(config, { OPENAI_API_KEY: "test-key" });
      const reply = await port.embed(["alpha"]);
      expect(reply.tokens).toBeUndefined();
      expect(reply.vectors).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });
});
