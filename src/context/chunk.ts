import path from "node:path";
import { SIGNATURE_PATTERNS } from "./repo-map.js";

export interface SourceChunk {
  startLine: number;
  text: string;
}

const MAX_CHUNK_LINES = 60;
const OVERLAP_LINES = 2;

/** A top-level declaration begins here (low indentation, known keyword). */
function isBoundary(line: string, pattern: RegExp | undefined): boolean {
  if (pattern === undefined) return false;
  // only column-0 or one-indent declarations start a new chunk, so nested
  // helpers stay with their parent
  if (/^\s{2,}/.test(line)) return false;
  return pattern.test(line);
}

/** Splits an oversized declaration body at blank lines, never mid-statement. */
function splitOversized(lines: readonly string[], startLine: number): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let current: string[] = [];
  let chunkStart = startLine;
  const flush = (): void => {
    /* v8 ignore next -- flush is only called with a non-empty buffer */
    if (current.length > 0) {
      chunks.push({ startLine: chunkStart, text: current.join("\n") });
    }
  };
  lines.forEach((line, index) => {
    current.push(line);
    const atBlank = line.trim() === "";
    if (current.length >= MAX_CHUNK_LINES && atBlank) {
      flush();
      current = [];
      chunkStart = startLine + index + 1;
    }
  });
  flush();
  return chunks;
}

/**
 * Boundary-aware chunks: each starts at a top-level declaration and runs to the
 * next, so a declaration whose body fits in a chunk is never split. Bodies past
 * the size ceiling split at blank lines. A small overlap preserves lexical
 * continuity for retrieval.
 */
export function chunkSource(relative: string, content: string): SourceChunk[] {
  if (content.trim() === "") return [];
  const pattern = SIGNATURE_PATTERNS[path.extname(relative)];
  const lines = content.split("\n");

  // group line indices into declaration-bounded segments
  const segments: { start: number; lines: string[] }[] = [];
  let current: { start: number; lines: string[] } = { start: 0, lines: [] };
  lines.forEach((line, index) => {
    if (isBoundary(line, pattern) && current.lines.length > 0) {
      segments.push(current);
      current = { start: index, lines: [] };
    }
    current.lines.push(line);
  });
  if (current.lines.length > 0) segments.push(current);

  const chunks: SourceChunk[] = [];
  for (const segment of segments) {
    if (segment.lines.every((line) => line.trim() === "")) continue;
    if (segment.lines.length <= MAX_CHUNK_LINES) {
      chunks.push({ startLine: segment.start + 1, text: segment.lines.join("\n") });
    } else {
      chunks.push(...splitOversized(segment.lines, segment.start + 1));
    }
  }

  // stitch a couple of lines of the previous chunk onto each for continuity
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = chunks[index - 1];
    const tail = previous?.text.split("\n").slice(-OVERLAP_LINES) ?? [];
    return { startLine: chunk.startLine, text: [...tail, ...chunk.text.split("\n")].join("\n") };
  });
}
