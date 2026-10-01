export async function importNotes(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(7500) });
}
