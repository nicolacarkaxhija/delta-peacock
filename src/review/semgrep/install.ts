import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** One pinned wheel: where it is and the sha256 it must have. */
export interface WheelPin {
  url: string;
  sha256: string;
}

/** The semgrep pins package.json carries. */
export interface SemgrepPins {
  version: string;
  wheels: Readonly<Record<string, WheelPin>>;
}

const END_OF_DIRECTORY = 0x06054b50;
const END_RECORD = 22;
const CENTRAL_HEADER = 46;
const LOCAL_HEADER = 30;
const DEFLATE = 8;

/** A path inside the bin folder that would land outside it. */
const unsafe = (name: string): boolean =>
  path.isAbsolute(name) || name.split(/[\\/]/).includes("..");

/**
 * The files of a wheel's bin folder, read from the zip's central directory;
 * folders and python files stay out, and an entry that would leave the
 * folder is refused.
 */
export function unpackBin(zip: Buffer, version: string): { name: string; data: Buffer }[] {
  const bin = `semgrep-${version}.data/purelib/semgrep/bin/`;
  let end = zip.length - END_RECORD;
  while (end >= 0 && zip.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error("the wheel is no zip archive");
  const count = zip.readUInt16LE(end + 10);
  let entry = zip.readUInt32LE(end + 16);
  const files: { name: string; data: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(entry + 10);
    const size = zip.readUInt32LE(entry + 20);
    const nameLength = zip.readUInt16LE(entry + 28);
    const local = zip.readUInt32LE(entry + 42);
    const name = zip.toString("utf8", entry + CENTRAL_HEADER, entry + CENTRAL_HEADER + nameLength);
    entry +=
      CENTRAL_HEADER + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
    if (!name.startsWith(bin) || name.endsWith("/") || name.endsWith(".py")) continue;
    const relative = name.slice(bin.length);
    if (unsafe(relative)) throw new Error(`unsafe archive entry ${name}`);
    const start =
      local + LOCAL_HEADER + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + size);
    files.push({ name: relative, data: method === DEFLATE ? inflateRawSync(packed) : packed });
  }
  return files;
}

export interface InstallOptions {
  pins: SemgrepPins;
  /** `<platform>-<arch>` as node names them. */
  platform: string;
  dir: string;
  download: (url: string) => Promise<Buffer>;
}

/**
 * Installs the pinned semgrep into dir: the wheel for the platform, checked
 * against its sha256, unpacked to the semgrep-core binary with an osemgrep
 * link, under which name semgrep-core acts as the CLI. Returns dir.
 */
export async function installSemgrep(options: InstallOptions): Promise<string> {
  const link = path.join(options.dir, "osemgrep");
  if (existsSync(link)) return options.dir;
  const wheel = options.pins.wheels[options.platform];
  if (wheel === undefined) {
    throw new Error(
      `no pinned semgrep wheel for ${options.platform}; pinned: ${Object.keys(options.pins.wheels).join(", ")}`,
    );
  }
  const zip = await options.download(wheel.url);
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== wheel.sha256) {
    throw new Error(`sha256 mismatch for ${wheel.url}: ${digest}, pinned ${wheel.sha256}`);
  }
  for (const file of unpackBin(zip, options.pins.version)) {
    const target = path.join(options.dir, file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.data, { mode: 0o755 });
  }
  symlinkSync("semgrep-core", link);
  return options.dir;
}
