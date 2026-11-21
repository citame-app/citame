import { expect, test } from "@playwright/test";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";
import { addCustomItem, closeReceipt, reviewReceipt } from "./pos-helpers";

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
      await page.getByRole("button", { name: "Cash registers", exact: true }).click();
      await page.getByLabel("Opening cash", { exact: true }).fill("50.00");
      await page.getByRole("button", { name: "Open register", exact: true }).click();
      await expect(page.getByText("The cash register is open", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      const label = `Checkout ${crypto.randomUUID()}`;
      await addCustomItem(page, label, "25.00");
      await page.locator("summary").filter({ hasText: "Discount · Tip" }).click();
      await page.getByLabel("Tip (EUR)", { exact: true }).fill("1.50");
      await reviewReceipt(page);
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
      await closeReceipt(page);
      await page.getByRole("button", { name: "Cash registers", exact: true }).click();
      const register = page.getByRole("region", { name: "Cash register", exact: true });
      await expect(register.getByText("€57.50", { exact: true })).toBeVisible();
      await register.getByLabel("Counted cash", { exact: true }).fill("57.00");
      await register.getByRole("button", { name: "Close and reconcile", exact: true }).click();
      await expect(
        register.getByText("The cash register is closed", { exact: true }),
      ).toBeVisible();
      await expect(register.getByText("-€0.50", { exact: true })).toBeVisible();
    });
  });
}

test("transaction totals include all filtered receipts and update after a remote payment", async ({
  page,
}) => {
  const owner = await asOwner();
  const name = `Period ${crypto.randomUUID()}`;
  const pay = (id: string) =>
    owner.post(`/api/admin/commerce/checkouts/${id}/payments`, {
      data: {
        idempotencyKey: crypto.randomUUID(),
        method: "external_card",
        amountCents: 1200,
      },
    });
  try {
    const salon = await owner.get("/api/salon");
    expect(salon.ok()).toBe(true);
    const { timezone } = await salon.json();
    const dateFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const receipts: { id: string; date: string; paid: boolean }[] = [];
    for (let index = 1; index <= 26; index++) {
      const sale = await owner.post("/api/admin/commerce/checkouts", {
        data: {
          idempotencyKey: crypto.randomUUID(),
          lines: [
            { kind: "custom", description: `${name} ${index}`, quantity: 1, unitAmountCents: 1200 },
          ],
        },
      });
      expect(sale.status(), await sale.text()).toBe(201);
      const { id, createdAt } = await sale.json();
      const paid = index !== 26;
      if (paid) expect((await pay(id)).status()).toBe(201);
      receipts.unshift({ id, date: dateFormatter.format(new Date(createdAt)), paid });
    }
    await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=transactions");
    const view = page.getByRole("region", { name: "Transactions", exact: true });
    await view.getByRole("searchbox").fill(name);
    const totals = view.locator(".commerce-transaction-totals");
    const payments = totals
      .getByText("Recorded payments", { exact: true })
      .locator("xpath=following-sibling::dd");
    const expectPayments = async (page: typeof receipts, month: boolean) => {
      const key = ({ date }: (typeof receipts)[number]) => (month ? date.slice(0, 7) : date);
      const expected = [...new Set(page.map(key))]
        .sort()
        .reverse()
        .map(
          (period) =>
            `€${receipts.filter((receipt) => receipt.paid && key(receipt) === period).length * 12}`,
        );
      await expect(payments).toHaveText(expected);
    };
    await expect(view.getByText("Showing 1-25 of 26")).toBeVisible();
    await expectPayments(receipts.slice(0, 25), false);
    await view.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(view.getByText("Showing 26-26 of 26")).toBeVisible();
    await expectPayments(receipts.slice(25), false);
    await view.getByRole("button", { name: "Months", exact: true }).click();
    await expect(view.getByRole("button", { name: "Months", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectPayments(receipts.slice(25), true);
    await view.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(view.getByText("Showing 1-25 of 26")).toBeVisible();
    await expectPayments(receipts.slice(0, 25), true);
    const unpaid = receipts[0];
    if (!unpaid) throw new Error("Missing unpaid receipt");
    expect((await pay(unpaid.id)).status()).toBe(201);
    unpaid.paid = true;
    await expectPayments(receipts.slice(0, 25), true);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "transaction period totals");
  } finally {
    await owner.dispose();
  }
});
