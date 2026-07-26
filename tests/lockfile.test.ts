import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withLock } from "../src/util/lockfile.js";

function tempTarget(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "dp-lock-")), "counter.json");
}

describe("withLock", () => {
  it("runs the update while holding the lock, then removes it", async () => {
    const target = tempTarget();
    let ran = false;
    const ok = await withLock(target, () => {
      ran = true;
      expect(existsSync(`${target}.lock`)).toBe(true);
    });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("reclaims a lock left behind by a crashed holder", async () => {
    const target = tempTarget();
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, "12345"); // a dead pid
    const oneMinuteAgo = Date.now() / 1000 - 60;
    utimesSync(lockPath, oneMinuteAgo, oneMinuteAgo);
    let ran = false;
    const ok = await withLock(target, () => {
      ran = true;
    });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
  });

  it("skips the update rather than write without the lock", async () => {
    const target = tempTarget();
    writeFileSync(`${target}.lock`, "12345"); // a fresh, still-held lock
    let ran = false;
    const ok = await withLock(
      target,
      () => {
        ran = true;
      },
      { attempts: 2, spinMs: 1, staleMs: 60_000 },
    );
    expect(ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("backs off asynchronously instead of busy-waiting the event loop", async () => {
    const target = tempTarget();
    // a fresh, still-held lock: every attempt contends and must back off
    writeFileSync(`${target}.lock`, "12345");
    const startedSync = performance.now();
    const resultPromise = withLock(target, () => undefined, {
      attempts: 3,
      spinMs: 50,
      staleMs: 60_000,
    });
    const syncElapsed = performance.now() - startedSync;
    // a busy-wait blocks the thread for attempts * spinMs (~150ms) before even
    // returning; an async backoff yields at the first await and returns a
    // still-pending promise almost immediately
    expect(syncElapsed).toBeLessThan(20);
    expect(await resultPromise).toBe(false);
  });
});
