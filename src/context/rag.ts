import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "../git/git.js";
import { chunkSource } from "./chunk.js";
import { cosine, type EmbeddingPort } from "./embedding.js";
import type { ContextInput, ContextProvider } from "./port.js";

const CACHE_DIR = ".delta-peacock-cache";
const CACHE_FILE = "rag-index.json";
const EMBED_CACHE_FILE = "rag-embeddings.json";
const TOP_CHUNKS = 8;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "vendor",
  "build",
  CACHE_DIR,
]);
const MAX_FILE_BYTES = 256 * 1024;

interface Chunk {
  file: string;
  startLine: number;
  text: string;
  terms: Record<string, number>;
}

interface RagIndex {
  version: 1;
  treeKey: string;
  chunks: Chunk[];
}

function tokenize(text: string): string[] {
  return [...text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)].map((match) => match[0].toLowerCase());
}

function termCounts(tokens: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

function buildChunks(cwd: string): Chunk[] {
  const chunks: Chunk[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
        const content = readFileSync(full, "utf8");
        if (content.includes("\u0000")) continue; // binary
        const relative = path.relative(cwd, full).replaceAll("\\", "/");
        for (const chunk of chunkSource(relative, content)) {
          chunks.push({
            file: relative,
            startLine: chunk.startLine,
            text: chunk.text,
            terms: termCounts(tokenize(chunk.text)),
          });
        }
      } catch {
        // unreadable files contribute nothing
      }
    }
  };
  walk(cwd);
  return chunks;
}

function isChunk(value: unknown): value is Chunk {
  if (typeof value !== "object" || value === null) return false;
  const chunk = value as Record<string, unknown>;
  return (
    typeof chunk["file"] === "string" &&
    typeof chunk["startLine"] === "number" &&
    typeof chunk["text"] === "string" &&
    typeof chunk["terms"] === "object" &&
    chunk["terms"] !== null
  );
}

function treeKeyOf(cwd: string): string {
  try {
    return runGit(cwd, ["rev-parse", "HEAD^{tree}"]).trim();
  } catch {
    return "no-tree";
  }
}

function scoreChunk(chunk: Chunk, queryTerms: readonly string[], idf: Map<string, number>): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = chunk.terms[term];
    if (tf !== undefined) score += tf * (idf.get(term) ?? 0);
  }
  return score;
}

export interface EmbeddedChunk {
  file: string;
  startLine: number;
  text: string;
  vector: number[];
}

interface EmbedIndex {
  version: 1;
  treeKey: string;
  /** Vectors from one backend and model never rank another's query. */
  embeddingKey: string;
  chunks: EmbeddedChunk[];
}

/** A small, stable key for a chunk's content, so reuse never holds full text. */
function contentKey(chunk: { file: string; text: string }): string {
  // file paths hold no newline, so it is a collision-free separator
  return createHash("sha1").update(`${chunk.file}\n${chunk.text}`).digest("hex");
}

export function isEmbeddedChunk(value: unknown): value is EmbeddedChunk {
  if (typeof value !== "object" || value === null) return false;
  const chunk = value as Record<string, unknown>;
  return (
    typeof chunk["file"] === "string" &&
    typeof chunk["startLine"] === "number" &&
    typeof chunk["text"] === "string" &&
    Array.isArray(chunk["vector"]) &&
    chunk["vector"].every((entry) => typeof entry === "number")
  );
}

export interface RagEmbeddingsOptions {
  port: EmbeddingPort;
  /** Distinguishes cache entries: provider plus model id. */
  embeddingKey: string;
}

/**
 * Embeddings retrieval: repository chunks and the diff meet in vector space.
 * The on-disk cache stores vectors keyed by tree, backend and model, so a
 * model switch can never rank against stale vectors.
 */
export function createRagEmbeddingsProvider(options: RagEmbeddingsOptions): ContextProvider {
  const notices: string[] = [];
  return {
    name: "rag",
    notices: () => notices,
    async systemContext(input: ContextInput): Promise<string> {
      const cachePath = path.join(input.cwd, CACHE_DIR, EMBED_CACHE_FILE);
      const treeKey = treeKeyOf(input.cwd);
      const cacheUsable = treeKey !== "no-tree";
      let index: EmbedIndex | undefined;
      // vectors from a previous run, reusable by content even when the tree moved
      let reusable: EmbeddedChunk[] = [];
      if (cacheUsable && existsSync(cachePath)) {
        try {
          const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
            version?: number;
            treeKey?: string;
            embeddingKey?: string;
            chunks?: unknown[];
          };
          if (
            parsed.version === 1 &&
            parsed.embeddingKey === options.embeddingKey &&
            Array.isArray(parsed.chunks) &&
            parsed.chunks.every(isEmbeddedChunk)
          ) {
            if (parsed.treeKey === treeKey) {
              index = {
                version: 1,
                treeKey,
                embeddingKey: options.embeddingKey,
                chunks: parsed.chunks,
              };
            } else {
              reusable = parsed.chunks;
            }
          }
        } catch {
          notices.push("rag embeddings cache was unreadable; rebuilding it");
        }
      }
      if (index === undefined) {
        const chunks = buildChunks(input.cwd);
        // reuse a cached vector whenever a chunk's content is byte-identical, so
        // a one-file change in a large tree re-embeds one file, not the repo
        const reuseByContent = new Map(reusable.map((chunk) => [contentKey(chunk), chunk.vector]));
        const embedded: (number[] | undefined)[] = chunks.map((chunk) =>
          reuseByContent.get(contentKey(chunk)),
        );
        const missIndexes = embedded.flatMap((vector, at) => (vector === undefined ? [at] : []));
        if (missIndexes.length > 0) {
          let fresh: number[][];
          try {
            fresh = (await options.port.embed(missIndexes.map((at) => chunks[at]?.text ?? "")))
              .vectors;
          } catch (error) {
            notices.push(
              `embeddings unavailable (${(error as Error).message}); continuing without retrieval`,
            );
            return "";
          }
          missIndexes.forEach((at, k) => {
            embedded[at] = fresh[k] ?? [];
          });
        }
        if (reusable.length > 0) {
          notices.push(
            `rag index: reused ${String(chunks.length - missIndexes.length)} vector(s), embedded ${String(missIndexes.length)} changed`,
          );
        }
        index = {
          version: 1,
          treeKey,
          embeddingKey: options.embeddingKey,
          chunks: chunks.map((chunk, at) => ({
            file: chunk.file,
            startLine: chunk.startLine,
            text: chunk.text,
            vector: embedded[at] ?? [],
          })),
        };
        if (cacheUsable) {
          try {
            mkdirSync(path.dirname(cachePath), { recursive: true });
            writeFileSync(cachePath, JSON.stringify(index));
          } catch /* v8 ignore next 3 -- disk-full or permission failure, not simulable portably */ {
            notices.push("could not write the rag embeddings cache; continuing without it");
          }
        }
      }

      const changed = new Set(input.changedFiles);
      const candidates = index.chunks.filter((chunk) => !changed.has(chunk.file));
      if (candidates.length === 0) return "";

      let queryVector: number[];
      try {
        queryVector = (await options.port.embed([input.diff])).vectors[0] ?? [];
      } catch (error) {
        notices.push(
          `embeddings unavailable (${(error as Error).message}); continuing without retrieval`,
        );
        return "";
      }
      const ranked = candidates
        .map((chunk) => ({ chunk, score: cosine(queryVector, chunk.vector) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_CHUNKS);
      if (ranked.length === 0) return "";

      const lines = ["Retrieved repository excerpts (embedding retrieval, read-only background):"];
      for (const { chunk } of ranked) {
        lines.push(`--- ${chunk.file}:${String(chunk.startLine)} ---`, chunk.text);
      }
      return lines.join("\n");
    },
  };
}

/**
 * Experimental: lexical TF-IDF retrieval over chunked repository content.
 * Weakest cross-file signal of the strategies; embeddings are the upgrade
 * path. Ships clearly labeled as such.
 */
export function createRagProvider(): ContextProvider {
  const notices: string[] = [];
  return {
    name: "rag",
    notices: () => notices,
    systemContext(input: ContextInput): string {
      const cachePath = path.join(input.cwd, CACHE_DIR, CACHE_FILE);
      const treeKey = treeKeyOf(input.cwd);
      // without a resolvable tree there is no honest cache key, so neither
      // read nor write the cache: a committed poisoned index must not validate
      const cacheUsable = treeKey !== "no-tree";
      let index: RagIndex | undefined;
      if (cacheUsable && existsSync(cachePath)) {
        try {
          const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
            version?: number;
            treeKey?: string;
            chunks?: unknown[];
          };
          if (parsed.version === 1 && parsed.treeKey === treeKey && Array.isArray(parsed.chunks)) {
            const chunks = parsed.chunks.filter(isChunk);
            if (chunks.length === parsed.chunks.length) {
              index = { version: 1, treeKey, chunks };
            } else {
              notices.push("rag index cache held malformed entries; rebuilding it");
            }
          }
        } catch {
          notices.push("rag index cache was unreadable; rebuilding it");
        }
      }
      if (index === undefined) {
        index = { version: 1, treeKey, chunks: buildChunks(input.cwd) };
        if (cacheUsable) {
          try {
            mkdirSync(path.dirname(cachePath), { recursive: true });
            writeFileSync(cachePath, JSON.stringify(index));
          } catch /* v8 ignore next 3 -- disk-full or permission failure, not simulable portably */ {
            notices.push("could not write the rag index cache; continuing without it");
          }
        }
      }

      const changed = new Set(input.changedFiles);
      const candidates = index.chunks.filter((chunk) => !changed.has(chunk.file));
      if (candidates.length === 0) return "";

      const documentFrequency = new Map<string, number>();
      for (const chunk of candidates) {
        for (const term of Object.keys(chunk.terms)) {
          documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
      }
      const idf = new Map<string, number>();
      for (const [term, frequency] of documentFrequency) {
        idf.set(term, Math.log(1 + candidates.length / frequency));
      }

      const queryTerms = [...new Set(tokenize(input.diff))];
      const ranked = candidates
        .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTerms, idf) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_CHUNKS);
      if (ranked.length === 0) return "";

      const lines = [
        "Retrieved repository excerpts (experimental lexical retrieval, read-only background):",
      ];
      for (const { chunk } of ranked) {
        lines.push(`--- ${chunk.file}:${String(chunk.startLine)} ---`, chunk.text);
      }
      return lines.join("\n");
    },
  };
}
