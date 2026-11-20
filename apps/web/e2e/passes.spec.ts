import { expect, test } from "@playwright/test";
import {
  asOwner,
  at,
  expectNoHorizontalScroll,
  HAIRCUT,
  nextWeekday,
  OWNER_EMAIL,
  STYLIST_A,
  signInAs,
} from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`packages and memberships — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("configures, funds, redeems and returns original whole visit allocations", async ({
      page,
    }) => {
      const owner = await asOwner();
      const services = await (await owner.get("/api/admin/services")).json();
      const original = services.services.find((s: { id: string }) => s.id === HAIRCUT);
      if (!original) throw new Error("Missing sample haircut");
      let booking: { id: string; clientId: string; version: number } | null = null;
      const label = `Three visits ${crypto.randomUUID()}`;
      const buyer = `Pass buyer ${crypto.randomUUID()}`;
      try {
        const edit = await owner.patch(`/api/admin/services/${HAIRCUT}`, {
          data: { version: original.version, currency: "EUR", priceCents: 2000 },
        });
        expect(edit.ok(), await edit.text()).toBe(true);
        for (let day = 35; day < 50; day++) {
          const response = await owner.post("/api/appointments", {
            data: {
              staffId: STYLIST_A,
              serviceIds: [HAIRCUT],
              startsAt: at(nextWeekday(day), "10:00"),
              client: { name: buyer },
              override: true,
            },
          });
          if (response.status() === 409) continue;
          expect(response.status(), await response.text()).toBe(201);
          booking = await response.json();
          break;
        }
        if (!booking) throw new Error("No free fixture slot");
        await signInAs(page, OWNER_EMAIL, "/admin/commerce");
        await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByRole("button", { name: "Manage plans", exact: true }).click();
        await page.getByRole("button", { name: "New plan", exact: true }).click();
        await page.getByLabel("Plan name", { exact: true }).fill(label);
        await page.getByLabel("Price (EUR)", { exact: true }).fill("10");
        await page.getByLabel("Included visits", { exact: true }).fill("3");
        await page.getByRole("checkbox", { name: original.name, exact: true }).check();
        await page.getByRole("button", { name: "Save plan", exact: true }).click();
        const planCard = page
          .locator("div.rounded-xl")
          .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
        await planCard.getByRole("button", { name: "Purchase plan", exact: true }).click();
        await planCard.getByLabel("Search buyer", { exact: true }).fill(buyer);
        await planCard.getByLabel("Buyer account", { exact: true }).selectOption({ label: buyer });
        const purchaseResponse = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/passes") && r.request().method() === "POST",
        );
        await planCard.getByRole("button", { name: "Create purchase", exact: true }).click();
        const purchase = await (await purchaseResponse).json();
        const detail = page.getByRole("region", { name: "View pass", exact: true });
        await expect(
          detail.getByText("0 available · 0 used · 0 held for refund", { exact: true }),
        ).toBeVisible();
        await detail.getByRole("button", { name: "Purchase receipt", exact: true }).click();
        const receipt = detail.getByRole("region", { name: "Receipt", exact: true });
        await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
        await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
        await expect(
          detail.getByText("3 available · 0 used · 0 held for refund", { exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `funded package ${scheme}`);
        const saleResponse = await owner.post("/api/admin/commerce/checkouts", {
          data: { appointmentId: booking.id, idempotencyKey: crypto.randomUUID() },
        });
        expect(saleResponse.status()).toBe(201);
        const sale = await saleResponse.json();
        await page.goto(`/admin/commerce?view=transactions&checkout=${sale.id}`);
        const serviceReceipt = page.getByRole("region", { name: "Receipt", exact: true });
        await serviceReceipt
          .getByLabel("Service covered by this visit", { exact: true })
          .selectOption({ label: `${label} · ${original.name} · €20` });
        await serviceReceipt
          .getByRole("button", { name: "Use prepaid visit", exact: true })
          .click();
        await expect(
          serviceReceipt.getByRole("status").filter({ hasText: /^Paid$/ }),
        ).toBeVisible();
        await serviceReceipt.getByRole("button", { name: "Refund payment", exact: true }).click();
        await expect(serviceReceipt.getByLabel("Refund amount", { exact: true })).toHaveValue(
          "20.00",
        );
        await expect(serviceReceipt.getByLabel("Refund amount", { exact: true })).toHaveAttribute(
          "readonly",
        );
        await serviceReceipt
          .getByLabel("Refund reason", { exact: true })
          .fill("Restore original funded visit");
        await serviceReceipt
          .getByRole("button", { name: "Confirm refund request", exact: true })
          .click();
        await expect(
          serviceReceipt.getByRole("status").filter({ hasText: /^Refunded$/ }),
        ).toBeVisible();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Close panel", exact: true })
          .click();
        await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
        await page.getByRole("button", { name: "Packages", exact: true }).click();
        await page.getByLabel("Search pass name", { exact: true }).fill(label);
        await page.getByRole("button", { name: "View pass", exact: true }).click();
        await expect(
          detail.getByText("3 available · 0 used · 0 held for refund", { exact: true }),
        ).toBeVisible();
        await detail.getByRole("button", { name: "Purchase receipt", exact: true }).click();
        await receipt.getByRole("button", { name: "Refund payment", exact: true }).click();
        await receipt.getByLabel("Unused visits to return", { exact: true }).fill("1");
        await expect(receipt.getByLabel("Refund amount", { exact: true })).toHaveValue("3.34");
        await receipt
          .getByLabel("Refund reason", { exact: true })
          .fill("Return one unused funded visit");
        await receipt.getByRole("button", { name: "Confirm refund request", exact: true }).click();
        await expect(
          detail.getByText("2 available · 0 used · 0 held for refund", { exact: true }),
        ).toBeVisible();
        const persisted = await (await owner.get(`/api/admin/passes/${purchase.pass.id}`)).json();
        expect(persisted.periods[0]).toMatchObject({
          availableUses: 2,
          returnedUses: 1,
          remainingAllocationCents: 666,
        });
        const finalized = await (
          await owner.get(`/api/admin/commerce/checkouts/${sale.id}`)
        ).json();
        expect(finalized.refundedCents).toBe(2000);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `returned package ${scheme}`);
      } finally {
        if (booking) {
          await owner.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        }
        const current = await (await owner.get("/api/admin/services")).json();
        const row = current.services.find((s: { id: string }) => s.id === HAIRCUT);
        if (row) {
          const restored = await owner.patch(`/api/admin/services/${HAIRCUT}`, {
            data: {
              version: row.version,
              currency: original.currency,
              priceCents: original.priceCents,
            },
          });
          expect(restored.ok(), await restored.text()).toBe(true);
        }
        await owner.dispose();
      }
    });
  });
}
