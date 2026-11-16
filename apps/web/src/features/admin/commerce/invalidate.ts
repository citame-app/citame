import type { QueryClient } from "@tanstack/react-query";
/** Financial mutations affect receipts, stock, cash and earned commissions together. */
export function invalidateCommerce(queries: QueryClient) {
  return Promise.all(
    [
      "commerce",
      "inventory",
      "accounting",
      "gift-cards",
      "passes",
      "appointments",
      "availability",
      "admin",
    ].map((key) => queries.invalidateQueries({ queryKey: [key] })),
  );
}
