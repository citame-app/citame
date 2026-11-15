import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`gift cards — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("paid gift activation, isolated voucher, partial redemption and refund to gift balance", async ({
      page,
    }) => {
      const label = `Birthday ${crypto.randomUUID()}`;
      await signInAs(page, OWNER_EMAIL, "/admin/commerce");
      await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
      await page.getByRole("button", { name: "New gift card", exact: true }).click();
      await page.getByLabel("Gift value (EUR)", { exact: true }).fill("50");
      await page.getByLabel("Recipient or reference", { exact: true }).fill(label);
      await page.getByRole("button", { name: "Create gift purchase", exact: true }).click();
      const detail = page.getByRole("region", { name: "View gift card", exact: true });
      await expect(detail.getByText("Awaiting purchase payment", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Show gift code", exact: true })).toHaveCount(
        0,
      );
      const purchase = detail.getByRole("region", { name: "Receipt", exact: true });
      await purchase.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await purchase.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(detail.getByText("Active", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "Show gift code", exact: true }).click();
      const codeGroup = detail.getByRole("group", { name: "Gift card code", exact: true });
      await expect(codeGroup).toBeVisible();
      const code = (await codeGroup.locator("code").textContent())?.trim() ?? "";
      expect(code).toMatch(/^SOB-/);
      await page.evaluate(() => {
        const original = Element.prototype.append;
        Element.prototype.append = function (...nodes) {
          original.apply(this, nodes);
          for (const node of nodes)
            if (node instanceof HTMLIFrameElement && node.hasAttribute("data-sob-print-frame")) {
              const target = node.contentWindow;
              if (target)
                target.print = () => {
                  (window as unknown as { printedGift: string }).printedGift =
                    node.contentDocument?.body.textContent ?? "";
                };
            }
        };
      });
      await detail.getByRole("button", { name: "Print gift voucher", exact: true }).click();
      const printed = await page.evaluate(
        () => (window as unknown as { printedGift: string }).printedGift,
      );
      expect(printed).toContain(code);
      expect(printed).toContain("€50");
      expect(printed).not.toContain("Cash register");
      expect(printed).not.toContain("Record payment");
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `gift voucher ${scheme}`);
      await page.getByRole("button", { name: "Back to sales", exact: true }).click();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      await page.getByLabel("Item or service", { exact: true }).fill(`Gift redemption ${label}`);
      await page.getByLabel("Price (EUR)", { exact: true }).fill("20");
      await page.getByRole("button", { name: "Create checkout", exact: true }).click();
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("gift_card");
      await receipt.getByLabel("Gift card code", { exact: true }).fill(code);
      await receipt.getByRole("button", { name: "Redeem gift card", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      await receipt.getByRole("button", { name: "Refund payment", exact: true }).click();
      await receipt.getByLabel("Refund amount", { exact: true }).fill("5");
      await receipt
        .getByLabel("Refund reason", { exact: true })
        .fill("Partial refund to gift balance");
      await receipt.getByRole("button", { name: "Confirm refund request", exact: true }).click();
      await expect(
        receipt.getByRole("status").filter({ hasText: /^Partially refunded$/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
      await page.getByLabel("Gift card code", { exact: true }).fill(code);
      await page.getByRole("button", { name: "Check gift balance", exact: true }).click();
      const checker = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Check gift balance", exact: true }) });
      await expect(checker.getByText("Available: €35", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `gift redemption ${scheme}`);
    });
  });
}
