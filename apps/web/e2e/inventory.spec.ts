import { expect, test } from "@playwright/test";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`retail inventory — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("product creation, stock delivery, sale, physical return and archive", async ({
      page,
    }) => {
      const unique = crypto.randomUUID();
      const name = `Repair shampoo ${unique}`;
      await signInAs(page, OWNER_EMAIL, "/admin/commerce");
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("button", { name: "New product", exact: true }).click();
      await page.getByLabel("Product name", { exact: true }).fill(name);
      await page.getByLabel("SKU", { exact: true }).fill(`SH-${unique}`);
      await page.getByLabel("Sale price (EUR)", { exact: true }).fill("20.00");
      await page.getByLabel("Unit cost (EUR)", { exact: true }).fill("7.00");
      await page.getByLabel("Included tax (%)", { exact: true }).fill("21");
      await page.getByLabel("Opening stock", { exact: true }).fill("3");
      await page.getByLabel("Low stock threshold", { exact: true }).fill("1");
      await page.getByRole("button", { name: "Save product", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Stock history", exact: true })).toBeVisible();
      await page.getByLabel("Quantity", { exact: true }).fill("2");
      await page.getByLabel("Reason", { exact: true }).fill("Supplier delivery E2E");
      await page.getByRole("button", { name: "Record stock movement", exact: true }).click();
      await expect(page.getByText("Supplier delivery E2E", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
      await page.getByLabel("Search products", { exact: true }).fill(unique);
      await expect(page.getByText("Available: 5", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `inventory catalog ${scheme}`);
      await page.getByRole("button", { name: "Back to sales", exact: true }).click();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      await page.getByLabel("Search products", { exact: true }).fill(unique);
      const option = page.getByRole("option").filter({ hasText: name });
      await expect(option).toHaveCount(1);
      const productId = await option.getAttribute("value");
      if (!productId) throw new Error("Missing product option id");
      await page.getByLabel("Choose a product", { exact: true }).selectOption(productId);
      await page.getByRole("button", { name: "Add product", exact: true }).click();
      await page.getByLabel("Quantity", { exact: true }).fill("2");
      await page.getByRole("button", { name: "Create checkout", exact: true }).click();
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await expect(receipt.getByText(name)).toBeVisible();
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      await receipt.getByText("Return product to stock", { exact: true }).first().click();
      await receipt.getByLabel("Reason", { exact: true }).fill("Unopened customer return");
      await receipt.getByRole("button", { name: "Return product to stock", exact: true }).click();
      await expect(receipt.getByText("Product returned to stock", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `inventory receipt ${scheme}`);
      const owner = await asOwner();
      try {
        const response = await owner.get(`/api/admin/inventory/products?search=${unique}`);
        const data = await response.json();
        const product = data.products[0];
        expect(product.stockOnHand).toBe(4);
        expect(product.stockReserved).toBe(0);
        const archived = await owner.patch(`/api/admin/inventory/products/${product.id}`, {
          data: { active: false, version: product.version },
        });
        expect(archived.ok(), await archived.text()).toBe(true);
      } finally {
        await owner.dispose();
      }
    });
  });
}
