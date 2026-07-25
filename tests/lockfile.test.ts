import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withLock } from "../src/util/lockfile.js";

function tempTarget(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "dp-lock-")), "counter.json");
}

describe("withLock", () => {
  it("runs the update while holding the lock, then removes it", () => {
    const target = tempTarget();
    let ran = false;
    const ok = withLock(target, () => {
      ran = true;
      expect(existsSync(`${target}.lock`)).toBe(true);
    });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("reclaims a lock left behind by a crashed holder", () => {
    const target = tempTarget();
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, "12345"); // a dead pid
    const oneMinuteAgo = Date.now() / 1000 - 60;
    utimesSync(lockPath, oneMinuteAgo, oneMinuteAgo);
    let ran = false;
    const ok = withLock(target, () => {
      ran = true;
    });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
  });

  it("skips the update rather than write without the lock", () => {
    const target = tempTarget();
    writeFileSync(`${target}.lock`, "12345"); // a fresh, still-held lock
    let ran = false;
    const ok = withLock(
      target,
      () => {
        ran = true;
      },
      { attempts: 2, spinMs: 1, staleMs: 60_000 },
    );
    expect(ok).toBe(false);
    expect(ran).toBe(false);
  });
});
