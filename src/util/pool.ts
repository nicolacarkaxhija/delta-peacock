/** Runs jobs with at most `limit` in flight; results come back in job order. */
export async function inPool<T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}
