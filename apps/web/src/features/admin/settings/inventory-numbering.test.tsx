import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { inventoryNumberingQueryKey } from "~/lib/admin-queries";
import { renderApp } from "../../../../test/render";
import { InventoryNumbering } from "./inventory-numbering";

const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});

test("each series keeps its own draft and a restored exhausted series clears after review", async () => {
  let live = {
    generation: "initial",
    orders: { nextNumber: 4 as number | null, lastIssuedNumber: 3 },
    receipts: { nextNumber: 15, lastIssuedNumber: 14 },
  };
  globalThis.fetch = mock(async () => Response.json(live)) as unknown as typeof fetch;
  const view = renderApp(<InventoryNumbering />);
  const orders = within(await screen.findByRole("form", { name: "Purchase orders" }));
  const receipts = within(screen.getByRole("form", { name: "Supplier receipts" }));
  const label = "New next number";
  const review = "Review current numbering";
  fireEvent.input(orders.getByLabelText(label), { target: { value: "40" } });
  fireEvent.input(receipts.getByLabelText(label), { target: { value: "50" } });
  live = {
    ...live,
    generation: "restored",
    orders: { nextNumber: null, lastIssuedNumber: 2147483647 },
  };
  await act(async () =>
    view.queryClient.invalidateQueries({ queryKey: inventoryNumberingQueryKey }),
  );
  expect(receipts.getByLabelText(label)).toHaveValue("50");
  const reviewOrders = await orders.findByRole("button", { name: review });
  expect(receipts.getByRole("button", { name: "Advance numbering" })).toBeDisabled();
  fireEvent.click(reviewOrders);
  await waitFor(() => expect(orders.queryByRole("button", { name: review })).toBeNull());
  expect(orders.getByRole("status")).toHaveTextContent("This series has reached its limit.");
  expect(receipts.getByLabelText(label)).toHaveValue("50");
});
