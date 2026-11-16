import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll, nextWeekday } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`booking deposits with simulated Redsys — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("policy acceptance, partial signal, cancellation and original-method refund", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      let id: string | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/settings");
        await page.getByLabel("Deposit (% or EUR)", { exact: true }).fill("25");
        await page
          .getByRole("checkbox", { name: "Require a booking deposit", exact: true })
          .check();
        await page.getByRole("button", { name: "Save booking policy", exact: true }).click();
        await expect(page.getByText("Booking policy saved", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `deposit policy ${scheme}`);
        const date = nextWeekday(7);
        const available = await owner.get(
          `/api/availability?serviceIds=${fixture.haircut}&date=${date}`,
        );
        expect(available.ok(), await available.text()).toBe(true);
        const slot = (await available.json()).slots[0];
        if (!slot) throw new Error("No fixture slot");
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        const params = new URLSearchParams({
          services: fixture.haircut,
          staff: slot.staffId,
          date,
          slot: slot.startsAt,
          slotStaff: slot.staffId,
        });
        await signInThroughUi(page, fixture.clientEmail, `/book/review?${params}`);
        const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
        await expect(confirm).toBeDisabled();
        await page
          .getByRole("checkbox", {
            name: "I accept this deposit and cancellation policy.",
            exact: true,
          })
          .check();
        await expect(confirm).toBeEnabled();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `deposit agreement ${scheme}`);
        const created = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await confirm.click();
        const booking = await (await created).json();
        id = booking.id;
        expect(booking.protection).toMatchObject({ state: "pending", depositCents: 500 });
        await expect(
          page.getByRole("heading", { name: "Complete your reservation", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "View reservation receipt", exact: true }).click();
        const receipt = page.getByRole("region", { name: "Receipt", exact: true });
        await expect(receipt.getByLabel("Amount", { exact: true })).toHaveValue("5.00");
        await page.route("https://sis-t.redsys.es:25443/**", async (route) => {
          const fields = Object.fromEntries(new URLSearchParams(route.request().postData() ?? ""));
          const response = await page.request.post("/api/__recurring-fixture/settle", {
            headers: { "x-recurring-fixture": "local-only", "x-fixture-purpose": "deposit" },
            data: fields,
          });
          expect(response.status(), await response.text()).toBe(200);
          const { order } = await response.json();
          await route.fulfill({
            status: 302,
            headers: { location: `${fixture.baseURL}/payments/${order}` },
            body: "",
          });
        });
        await receipt.getByRole("button", { name: "Continue to payment", exact: true }).click();
        await receipt
          .getByRole("button", { name: "Pay securely with Redsys", exact: true })
          .click();
        await expect(page).toHaveURL(/\/payments\//);
        await expect(
          page.getByText("No payment is due before your visit.", { exact: true }),
        ).toBeVisible();
        const funded = await (
          await page.request.get(`/api/me/checkouts/${booking.protection.checkoutId}`)
        ).json();
        expect(funded).toMatchObject({
          paidCents: 500,
          balanceCents: 1500,
          payableCents: 0,
          fulfilledAt: null,
          protection: { state: "confirmed" },
        });
        await page.goto(`/account?highlight=${booking.id}`);
        const notice = page
          .getByRole("region", { name: "Booking deposits & cancellation", exact: true })
          .filter({ hasText: "Deposit confirmed" });
        await expect(notice).toBeVisible();
        const card = page.locator("article").filter({ has: notice });
        await card.getByRole("button", { name: "Cancel", exact: true }).click();
        const dialog = page
          .getByRole("alertdialog")
          .or(page.getByRole("dialog"))
          .filter({ hasText: "Cancel this appointment?" });
        await expect(dialog.getByText(/The accepted deposit policy applies/)).toBeVisible();
        await dialog.getByRole("button", { name: "Yes, cancel it", exact: true }).click();
        const cancelledCard = page.locator(`article[data-appointment-id="${booking.id}"]`);
        await expect(cancelledCard.getByText(/Still due back: €5\./)).toBeVisible();
        await page.screenshot({
          path: `/tmp/sob-deposit-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
        });
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `cancelled deposit ${scheme}`);
        const refund = await owner.post(
          `/api/admin/commerce/payments/${funded.payments[0].id}/refunds`,
          {
            data: {
              amountCents: 500,
              reason: "Early cancellation full deposit return",
              idempotencyKey: crypto.randomUUID(),
            },
          },
        );
        expect(refund.status(), await refund.text()).toBe(201);
        const refundId = (await refund.json()).id;
        const result = await owner.post(`/api/admin/commerce/refunds/${refundId}/execute`, {
          data: {},
        });
        expect(result.ok(), await result.text()).toBe(true);
        expect(await result.json()).toMatchObject({ status: "succeeded" });
        const final = await (
          await page.request.get(`/api/me/checkouts/${booking.protection.checkoutId}`)
        ).json();
        expect(final).toMatchObject({
          status: "void",
          refundedCents: 500,
          protection: { feeCents: 0, refundDueCents: 0 },
        });
      } finally {
        if (id) {
          const list = await owner.get(
            `/api/appointments?from=${new Date().toISOString()}&to=${new Date(Date.now() + 60 * 86400000).toISOString()}`,
          );
          const a = (await list.json()).appointments?.find((r: { id: string }) => r.id === id);
          if (a?.status === "booked")
            await owner.patch(`/api/appointments/${id}`, {
              data: { version: a.version, status: "cancelled" },
            });
        }
        const p = await (await owner.get("/api/admin/settings/booking-policy")).json();
        await owner.put("/api/admin/settings/booking-policy", { data: { ...p, enabled: false } });
        await owner.dispose();
      }
    });
  });
}
