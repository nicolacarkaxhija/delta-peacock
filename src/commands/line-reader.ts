/* v8 ignore start -- thin stdin adapter, exercised only by a human terminal */
/** The real-terminal fallback behind the RuntimeDeps.readLine seam. */
export async function stdinReader(): Promise<() => Promise<string | null>> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  let done = false;
  rl.on("line", (line) => lines.push(line));
  rl.on("close", () => {
    done = true;
  });
  return () =>
    new Promise((resolve) => {
      const poll = (): void => {
        const next = lines.shift();
        if (next !== undefined) resolve(next);
        else if (done) resolve(null);
        else setTimeout(poll, 20);
      };
      poll();
    });
}
/* v8 ignore stop */
