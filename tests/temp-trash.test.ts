import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STALE_MS, sweepTrash, trashPrefix } from "./helpers/temp-trash.js";

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
