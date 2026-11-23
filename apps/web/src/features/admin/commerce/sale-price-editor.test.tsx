import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { SalePriceEditor } from "./sale-price-editor";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the operator reviews the new catalog price without losing the agreed amount or reason", async () => {
  const itemId = "0198f5a0-7b1c-7000-8000-000000000101";
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    expect(url.pathname).toBe("/api/admin/commerce/catalog-price");
    expect(url.searchParams.get("id")).toBe(itemId);
    expect(url.searchParams.get("kind")).toBe("product");
    return Response.json({ unitAmountCents: 2200 });
  }) as unknown as typeof fetch;
  const onSave = mock();
  renderApp(
    <SalePriceEditor
      open
      disabled={false}
      onOpenChange={() => {}}
      onSave={onSave}
      item={{
        key: `product:${itemId}`,
        kind: "product",
        id: itemId,
        name: "Shampoo",
        priceCents: 2000,
        quantity: "2",
      }}
    />,
  );
  const amount = screen.getByRole("textbox", { name: "Unit price for this sale" });
  const reason = screen.getByRole("textbox", { name: "Reason for changing the price" });
  fireEvent.change(amount, { target: { value: "18,50" } });
  fireEvent.change(reason, { target: { value: "Agreed offer" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload catalog price" }));
  await waitFor(() => {
    const hint = document.getElementById(amount.getAttribute("aria-describedby") ?? "");
    const announcement = screen.getByRole("status");
    expect(hint?.textContent).toBe("Catalog price €22");
    expect(hint?.hidden).toBe(false);
    expect(hint).not.toBe(announcement);
    expect(announcement.textContent).toBe("Catalog price €22");
  });
  expect(onSave).not.toHaveBeenCalled();
  expect((amount as HTMLInputElement).value).toBe("18,50");
  expect((reason as HTMLInputElement).value).toBe("Agreed offer");
  fireEvent.submit(screen.getByRole("form", { name: "Change price for Shampoo" }));
  expect(onSave).toHaveBeenCalledWith(2200, {
    expectedUnitAmountCents: 2200,
    unitAmountCents: 1850,
    reason: "Agreed offer",
  });
});
