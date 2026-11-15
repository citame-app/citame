import { expect, test } from "@playwright/test";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`checkout and register — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("partial cash/card collection, receipt, refund and counted register close", async ({
      page,
    }) => {
      const owner = await asOwner();
      try {
        const response = await owner.get("/api/admin/commerce/cash-sessions/current");
        expect(response.ok()).toBe(true);
        const { session } = await response.json();
        if (session && !session.closedAt) {
          const close = await owner.post(`/api/admin/commerce/cash-sessions/${session.id}/close`, {
            data: { countedCents: session.expectedCents },
          });
          expect(close.ok(), await close.text()).toBe(true);
        }
      } finally {
        await owner.dispose();
      }
      await signInAs(page, OWNER_EMAIL, "/admin/commerce");
      await page.getByLabel("Opening cash", { exact: true }).fill("50.00");
      await page.getByRole("button", { name: "Open register", exact: true }).click();
      await expect(page.getByText("The cash register is open", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      const label = `Checkout ${crypto.randomUUID()}`;
      await page.getByLabel("Item or service", { exact: true }).fill(label);
      await page.getByLabel("Price (EUR)", { exact: true }).fill("25.00");
      await page.getByLabel("Tip", { exact: true }).fill("1.50");
      await page.getByRole("button", { name: "Create checkout", exact: true }).click();
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await expect(receipt.getByText(label)).toBeVisible();
      await receipt.getByLabel("Amount", { exact: true }).fill("12.50");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByLabel("Amount", { exact: true })).toHaveValue("14.00");
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      const cashPayment = receipt.getByText("Cash · €12.50", { exact: true }).locator("..");
      await cashPayment.getByRole("button", { name: "Refund payment", exact: true }).click();
      await cashPayment.getByLabel("Refund amount", { exact: true }).fill("5.00");
      await cashPayment
        .getByLabel("Refund reason", { exact: true })
        .fill("Partial customer refund");
      await cashPayment
        .getByRole("button", { name: "Confirm refund request", exact: true })
        .click();
      await expect(
        receipt.getByRole("status").filter({ hasText: /^Partially refunded$/ }),
      ).toBeVisible();
      await expect(receipt.getByText("Refund recorded", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `commerce ${scheme}`);
      await page.getByLabel("Counted cash", { exact: true }).fill("57.00");
      await page.getByRole("button", { name: "Close and reconcile", exact: true }).click();
      const register = page.getByRole("region", { name: "Cash register", exact: true });
      await expect(
        register.getByText("The cash register is closed", { exact: true }),
      ).toBeVisible();
      await expect(register.getByText("-€0.50", { exact: true })).toBeVisible();
    });
  });
}
