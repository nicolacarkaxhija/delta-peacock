interface CostExplorerResponse {
  ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string } } }[];
}

export type CostExplorerSend = (input: {
  TimePeriod: { Start: string; End: string };
  Granularity: "MONTHLY";
  Metrics: string[];
  Filter: { Dimensions: { Key: "SERVICE"; Values: string[] } };
}) => Promise<CostExplorerResponse>;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* v8 ignore start -- talks to real AWS; the live smoke exercises it, tests inject send */
async function defaultSend(): Promise<CostExplorerSend> {
  const { CostExplorerClient, GetCostAndUsageCommand } =
    await import("@aws-sdk/client-cost-explorer");
  const client = new CostExplorerClient({});
  return async (input) =>
    (await client.send(new GetCostAndUsageCommand(input))) as CostExplorerResponse;
}
/* v8 ignore stop */

/**
 * Month-to-date Amazon Bedrock spend from AWS Cost Explorer. Any failure
 * throws; the caller falls back to the local counter with a warning.
 */
export async function costExplorerMonthToDate(now: Date, send?: CostExplorerSend): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dispatch = send ?? (await defaultSend());
  const response = await dispatch({
    TimePeriod: { Start: isoDate(start), End: isoDate(end) },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    Filter: { Dimensions: { Key: "SERVICE", Values: ["Amazon Bedrock"] } },
  });
  let total = 0;
  for (const result of response.ResultsByTime ?? []) {
    const amount = Number(result.Total?.UnblendedCost?.Amount ?? "0");
    if (Number.isFinite(amount)) total += amount;
  }
  return total;
}
