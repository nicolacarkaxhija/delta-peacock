export function toRows(header: string[], rows: string[][]): string[][] {
  return [header, ...rows];
}
