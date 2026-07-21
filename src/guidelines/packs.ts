import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ToolError } from "../errors.js";
import { runGit } from "../git/git.js";
import { markdownFilesUnder, type GuidelineFile } from "./loader.js";

export const PACK_MANIFEST_NAME = "pack.yaml";

/** Where git-sourced packs land; content is addressed by url and ref, so a hit is authoritative. */
export const PACK_CACHE_DIR = path.join(".delta-peacock-cache", "packs");

export interface PackManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface ResolvedPack {
  manifest: PackManifest;
  /** Absolute directory the pack's files were read from. */
  dir: string;
  files: GuidelineFile[];
}

function splitRef(spec: string): { url: string; ref?: string } {
  const hash = spec.indexOf("#");
  if (hash === -1) return { url: spec };
  const ref = spec.slice(hash + 1);
  return ref === "" ? { url: spec.slice(0, hash) } : { url: spec.slice(0, hash), ref };
}

/** A git spec has a git-ish scheme or a .git suffix, optionally pinned with #ref. */
export function isGitPackSpec(spec: string): boolean {
  const { url } = splitRef(spec);
  return /^(https?|git):\/\//.test(url) || url.endsWith(".git");
}

/**
 * Shallow-fetches the pinned ref into the cache. A present cache directory is
 * reused as-is: a pin points at immutable history, so nothing needs refreshing.
 */
function fetchGitPack(cwd: string, spec: string): string {
  const { url, ref } = splitRef(spec);
  const key = createHash("sha256")
    .update(`${url}#${ref ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const dir = path.resolve(cwd, PACK_CACHE_DIR, key);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  try {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["remote", "add", "origin", url]);
    runGit(dir, ["fetch", "-q", "--depth", "1", "origin", ref ?? "HEAD"]);
    runGit(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  } catch (error) {
    // a half-clone must not poison the next run's cache hit
    rmSync(dir, { recursive: true, force: true });
    throw new ToolError(`pack ${spec}: ${(error as Error).message}`);
  }
  return dir;
}

function readManifest(dir: string, spec: string): PackManifest {
  const manifestPath = path.join(dir, PACK_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new ToolError(`pack ${spec}: no ${PACK_MANIFEST_NAME} manifest found`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ToolError(
      `pack ${spec}: unreadable ${PACK_MANIFEST_NAME} (${(error as Error).message})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(`pack ${spec}: ${PACK_MANIFEST_NAME} must be a mapping`);
  }
  const record = parsed as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new ToolError(`pack ${spec}: ${PACK_MANIFEST_NAME} needs a non-empty "name"`);
  }
  const version = record["version"];
  const description = record["description"];
  return {
    name: name.trim(),
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

/**
 * Resolves one pack spec to its manifest and guideline files. A git spec is
 * fetched into the cache at its pinned ref; anything else is a directory
 * resolved against the repo root, which also covers node_modules packages.
 */
export function resolvePack(cwd: string, spec: string): ResolvedPack {
  const dir = isGitPackSpec(spec) ? fetchGitPack(cwd, spec) : path.resolve(cwd, spec);
  if (!existsSync(dir)) {
    throw new ToolError(`pack ${spec}: directory not found at ${dir}`);
  }
  const manifest = readManifest(dir, spec);
  const files = markdownFilesUnder(dir).map((filePath) => ({
    displayPath: `${manifest.name}:${path.relative(dir, filePath).replaceAll("\\", "/")}`,
    content: readFileSync(filePath, "utf8"),
  }));
  return { manifest, dir, files };
}
