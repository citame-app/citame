import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Discards older responses without removing active query subscriptions. */
export async function clearPrivateQueryData(
  client: QueryClient,
  scope: QueryKey,
  failingKey?: QueryKey,
) {
  const filters = { queryKey: scope };
  await client.cancelQueries({ ...filters, predicate: ({ queryKey }) => queryKey !== failingKey });
  client.setQueriesData(filters, null);
}
