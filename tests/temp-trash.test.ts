import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STALE_MS, sweepTrash, trashPrefix } from "./helpers/temp-trash.js";

/** A folder under the parent, aged past the stale mark when asked. */
function folder(parent: string, name: string, stale = false): string {
  const dir = path.join(parent, name);
  mkdirSync(dir);
  if (stale) {
    const old = (Date.now() - STALE_MS - 1000) / 1000;
    utimesSync(dir, old, old);
  }
  return dir;
}

describe("sweepTrash", () => {
  it("deletes this run's trash, and other runs' trash only once it is stale", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "sweep-"));
    const mine = path.join(parent, `${trashPrefix("run-a")}one`);
    const fresh = path.join(parent, `${trashPrefix("run-b")}two`);
    const stale = path.join(parent, `${trashPrefix("run-c")}three`);
    const other = path.join(parent, "unrelated");
    for (const dir of [mine, fresh, stale, other]) mkdirSync(dir);
    const old = (Date.now() - STALE_MS - 1000) / 1000;
    utimesSync(stale, old, old);
    sweepTrash(parent, "run-a");
    expect([mine, fresh, stale, other].map((dir) => existsSync(dir))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });
});

describe("sweepTrash on leftovers", () => {
  it("deletes test folders a run left behind once they are stale, and keeps fresh ones", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "sweep-"));
    const stale = folder(parent, "peacock-test-old", true);
    const fresh = folder(parent, "peacock-test-new");
    sweepTrash(parent, undefined);
    expect([existsSync(stale), existsSync(fresh)]).toEqual([false, true]);
  });

  it("goes on when a folder vanishes between the listing and its check", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "sweep-"));
    folder(parent, `${trashPrefix("run-z")}gone`);
    const stale = folder(parent, `${trashPrefix("run-y")}old`, true);
    expect(() => {
      sweepTrash(parent, undefined, (name) => {
        if (name.endsWith("gone")) rmSync(path.join(parent, name), { recursive: true });
      });
    }).not.toThrow();
    expect(existsSync(stale)).toBe(false);
  });
});
