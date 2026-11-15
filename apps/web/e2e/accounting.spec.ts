import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations, PASSWORD } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`commissions and financial reports — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("configure rates, attribute a retail sale, inspect accrual and record a completed payout", async ({
      page,
    }) => {
      const unique = crypto.randomUUID();
      const name = `Retail ${unique}`;
      const email = `commission-${unique}@example.com`;
      const owner = await asOwner();
      let staffId: string;
      try {
        const staff = await owner.post("/api/admin/staff-accounts", {
          data: {
            email,
            name: `Professional ${unique}`,
            displayName: `Professional ${unique}`,
            password: PASSWORD,
          },
        });
        expect(staff.ok(), await staff.text()).toBe(true);
        staffId = (await staff.json()).staffId;
        const product = await owner.post("/api/admin/inventory/products", {
          data: {
            name,
            sku: `C-${unique}`,
            priceCents: 12100,
            costCents: 7000,
            taxBasisPoints: 2100,
            openingStock: 1,
            idempotencyKey: unique,
          },
        });
        expect(product.ok(), await product.text()).toBe(true);
      } finally {
        await owner.dispose();
      }
      await signInAs(page, OWNER_EMAIL, "/admin/commerce");
      await page
        .getByRole("button", { name: "Financial reports & commissions", exact: true })
        .click();
      await page.getByLabel("Professional", { exact: true }).selectOption(staffId);
      await page.getByLabel("Service commission (%)", { exact: true }).fill("25");
      await page.getByLabel("Product commission (%)", { exact: true }).fill("10");
      const savedRates = page.waitForResponse(
        (response) => response.url().endsWith("/policy") && response.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save commission rates", exact: true }).click();
      expect((await savedRates).ok()).toBe(true);
      await expect(page.getByLabel("Product commission (%)", { exact: true })).toHaveValue("10.00");
      await page.getByRole("button", { name: "Back to sales", exact: true }).click();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      await page.getByLabel("Professional", { exact: true }).selectOption(staffId);
      await page.getByLabel("Search products", { exact: true }).fill(unique);
      const option = page.getByRole("option").filter({ hasText: name });
      await expect(option).toHaveCount(1);
      const productId = await option.getAttribute("value");
      if (!productId) throw new Error("Missing product id");
      await page.getByLabel("Choose a product", { exact: true }).selectOption(productId);
      await page.getByRole("button", { name: "Add product", exact: true }).click();
      await page.getByRole("button", { name: "Create checkout", exact: true }).click();
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await expect(receipt.getByText(name)).toBeVisible();
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      await page
        .getByRole("button", { name: "Financial reports & commissions", exact: true })
        .click();
      await page.getByLabel("Professional", { exact: true }).selectOption(staffId);
      const panel = page.getByRole("region", { name: "Commissions", exact: true });
      await expect(
        panel
          .getByText("Outstanding commission", { exact: true })
          .locator("..")
          .getByText("€10", { exact: true }),
      ).toBeVisible();
      await panel.getByLabel("Payout amount (EUR)", { exact: true }).fill("5");
      await panel
        .getByLabel("Transfer or payment reference", { exact: true })
        .fill(`External transfer ${unique}`);
      await panel.getByRole("button", { name: "Record completed payout", exact: true }).click();
      await expect(
        panel
          .getByText("Outstanding commission", { exact: true })
          .locator("..")
          .getByText("€5", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText(`External transfer ${unique}`, { exact: true })).toBeVisible();
      const csvDownload = page.waitForEvent("download");
      await panel
        .getByRole("button", { name: "Export visible commission rows (CSV)", exact: true })
        .click();
      const downloaded = await csvDownload;
      const csvPath = await downloaded.path();
      if (!csvPath) throw new Error("Missing downloaded commission CSV");
      const csv = await readFile(csvPath, "utf8");
      expect(csv).toContain('"original_cents"');
      expect(csv).toContain('"1000"');
      expect(csv).toContain('"EUR"');
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `commissions ${scheme}`);
    });
  });
}
