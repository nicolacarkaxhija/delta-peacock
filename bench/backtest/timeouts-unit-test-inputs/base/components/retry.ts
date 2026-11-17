export interface RetryOptions {
  outcome: (timeout: number) => Promise<unknown>;
  attempts: number;
  timeout: number;
}

export async function retryUntilOutcome(
  act: () => Promise<void>,
  options: RetryOptions,
): Promise<unknown> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    await act();
    const result = await options.outcome(options.timeout);
    if (result !== undefined) return result;
  }
  return undefined;
}
