import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { installSemgrep, unpackBin, type SemgrepPins } from "../src/review/semgrep/install.js";

const VERSION = "9.9.9";
const BIN = `semgrep-${VERSION}.data/purelib/semgrep/bin/`;

/** A zip archive in memory: stored or deflated entries, a central directory, its end record. */
function zipOf(entries: { name: string; data: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data);
    const packed = entry.deflate === true ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.deflate === true ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.deflate === true ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const WHEEL = zipOf([
  { name: `${BIN}semgrep-core`, data: "#!/bin/sh\necho core\n", deflate: true },
  { name: `${BIN}libs/core-lib.dylib`, data: "lib" },
  { name: `${BIN}__init__.py`, data: "" },
  { name: `${BIN}libs/`, data: "" },
  { name: "semgrep/__init__.py", data: "" },
]);

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const pins = (digest = sha(WHEEL)): SemgrepPins => ({
  version: VERSION,
  wheels: { "test-arch": { url: "https://example.com/semgrep.whl", sha256: digest } },
});

describe("unpackBin", () => {
  it("unpacks the bin folder of a wheel, stored and deflated, and nothing else", () => {
    expect(unpackBin(WHEEL, VERSION).map((entry) => [entry.name, entry.data.toString()])).toEqual([
      ["semgrep-core", "#!/bin/sh\necho core\n"],
      ["libs/core-lib.dylib", "lib"],
    ]);
  });

  for (const name of [`${BIN}../../escape`, `${BIN}/etc/passwd`, `${BIN}libs/../../x`]) {
    it(`refuses the archive entry ${name}`, () => {
      expect(() => unpackBin(zipOf([{ name, data: "x" }]), VERSION)).toThrow(
        `unsafe archive entry ${name}`,
      );
    });
  }

  it("refuses a file that is no zip", () => {
    expect(() => unpackBin(Buffer.from("not a zip at all, long enough"), VERSION)).toThrow(
      "the wheel is no zip archive",
    );
  });
});

describe("installSemgrep", () => {
  const dirOf = (): string => path.join(mkdtempSync(path.join(tmpdir(), "install-")), "semgrep");

  it("downloads the pinned wheel, checks its digest and links osemgrep to the binary", async () => {
    const dir = dirOf();
    const urls: string[] = [];
    const done = await installSemgrep({
      pins: pins(),
      platform: "test-arch",
      dir,
      download: (url) => {
        urls.push(url);
        return Promise.resolve(WHEEL);
      },
    });
    expect(done).toBe(dir);
    expect(urls).toEqual(["https://example.com/semgrep.whl"]);
    expect(readFileSync(path.join(dir, "semgrep-core"), "utf8")).toBe("#!/bin/sh\necho core\n");
    expect(readlinkSync(path.join(dir, "osemgrep"))).toBe("semgrep-core");
  });

  it("downloads nothing when the binary is already in place", async () => {
    const dir = dirOf();
    const download = () => Promise.resolve(WHEEL);
    await installSemgrep({ pins: pins(), platform: "test-arch", dir, download });
    const again = await installSemgrep({
      pins: pins(),
      platform: "test-arch",
      dir,
      download: () => Promise.reject(new Error("no second download")),
    });
    expect(again).toBe(dir);
  });

  it("refuses a platform with no pinned wheel", async () => {
    await expect(
      installSemgrep({
        pins: pins(),
        platform: "other-arch",
        dir: dirOf(),
        download: () => Promise.resolve(WHEEL),
      }),
    ).rejects.toThrow("no pinned semgrep wheel for other-arch; pinned: test-arch");
  });

  it("refuses a wheel whose digest is not the pin and writes nothing", async () => {
    const dir = dirOf();
    await expect(
      installSemgrep({
        pins: pins("0".repeat(64)),
        platform: "test-arch",
        dir,
        download: () => Promise.resolve(WHEEL),
      }),
    ).rejects.toThrow(
      `sha256 mismatch for https://example.com/semgrep.whl: ${sha(WHEEL)}, pinned ${"0".repeat(64)}`,
    );
    expect(existsSync(dir)).toBe(false);
  });
});
