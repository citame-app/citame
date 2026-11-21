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
