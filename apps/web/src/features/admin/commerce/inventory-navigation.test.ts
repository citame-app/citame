import { expect, test } from "bun:test";
import { parseInventoryNavigation } from "./inventory-navigation";

test("stock receipt links keep a validated page and identifier", () => {
  const receipt = "0198f5a0-7b1c-7000-8000-000000000100";
  expect(
    parseInventoryNavigation({
      inventoryTab: "receipts",
      inventoryPage: 2,
      receipt,
      supplierSearch: "Not a filter here",
    }),
  ).toEqual({ inventoryTab: "receipts", inventoryPage: 2, receipt });
  expect(
    parseInventoryNavigation({
      inventoryTab: "suppliers",
      inventoryPage: -4,
      supplierStatus: "inactive",
      receipt,
    }),
  ).toEqual({ inventoryTab: "suppliers", supplierStatus: "inactive" });
});

test("purchase order links keep their own filters and reject invalid identifiers and states", () => {
  const order = "0198f5a0-7b1c-7000-8000-000000000102";
  expect(
    parseInventoryNavigation({
      inventoryTab: "orders",
      order,
      orderStatus: "partially_received",
      orderSearch: "Lab",
      inventoryPage: 5,
      receipt: order,
      supplierSearch: "Hidden",
    }),
  ).toEqual({
    inventoryTab: "orders",
    order,
    orderStatus: "partially_received",
    orderSearch: "Lab",
    inventoryPage: 5,
  });
  expect(
    parseInventoryNavigation({
      inventoryTab: "orders",
      order: "unknown",
      orderStatus: "overdue",
      orderSearch: "a".repeat(120),
      inventoryPage: 100001,
    }),
  ).toEqual({ inventoryTab: "orders", orderSearch: "a".repeat(100) });
  expect(parseInventoryNavigation({ inventoryTab: "receipts", order })).toEqual({
    inventoryTab: "receipts",
  });
});
