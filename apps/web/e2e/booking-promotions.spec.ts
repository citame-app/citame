import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
  switchLocale,
} from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`booking offers — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews discounted deposits, rejects changed offers and recovers the same booking through an uncertain and then unauthorized response", async ({
      page,
    }, info) => {
      test.setTimeout(150000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const code = `BOOK_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const terms = {
        code,
        name: `Offer_${scheme}_${info.project.name}_${"W".repeat(65)}`,
        kind: "percent",
        value: 2000,
        eligibleKinds: ["service"],
        timing: {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startMinute: 0,
          endMinute: 1440,
          lastMinuteHours: 168,
        },
      };
      let serviceId = "";
      let visit:
        | {
            id: string;
            version: number;
            protection: { checkoutId: string; depositCents: number; policyVersion: number };
          }
        | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const staff = (await (await owner.get("/api/staff")).json()).staff.find(
          (row: { displayName: string }) => row.displayName === "Stylist A",
        );
        const created = await owner.post("/api/admin/services", {
          data: {
            name: `Fixture offer treatment ${code}`,
            durationMinutes: 45,
            bufferMinutes: 0,
            priceCents: 10000,
            currency: "EUR",
            staffIds: [staff.id],
          },
        });
        expect(created.status(), await created.text()).toBe(201);
        serviceId = (await created.json()).id;
        const policy = await (await owner.get("/api/admin/settings/booking-policy")).json();
        const savedPolicy = await owner.put("/api/admin/settings/booking-policy", {
          data: { ...policy, enabled: true, depositKind: "percent", depositValue: 2500 },
        });
        expect(savedPolicy.status()).toBe(200);
        const policyVersion = (await savedPolicy.json()).version;
        const promo = await owner.post("/api/admin/rewards/promotions", { data: terms });
        expect(promo.status()).toBe(201);
        const promotion = await promo.json();
        await signInThroughUi(page, fixture.clientEmail, `/book?services=${serviceId}`);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(page, "Stylist A");
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByLabel("Promotion code (optional)", { exact: true }).fill(code);
        await expect(
          page.getByRole("button", { name: "Confirm booking", exact: true }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Review offer", exact: true }).click();
        await expect(page.getByText("Save €20 · Booking total €80", { exact: true })).toBeVisible();
        const consent = page.getByRole("region", {
          name: "Booking deposits & cancellation",
          exact: true,
        });
        await expect(consent).toContainText("Pay a deposit of €20");
        await page
          .getByLabel("I accept this deposit and cancellation policy.", { exact: true })
          .check();
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promotion.id}`, {
              data: { ...terms, value: 2500, version: promotion.version },
            })
          ).status(),
        ).toBe(200);
        let attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const rejected = await attempt;
        expect(rejected.status()).toBe(409);
        expect((await rejected.json()).error.code).toBe("booking_promotion_changed");
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toHaveValue(
          code,
        );
        await expect(
          page.getByRole("button", { name: "Confirm booking", exact: true }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Review offer", exact: true }).click();
        await expect(page.getByText("Save €25 · Booking total €75", { exact: true })).toBeVisible();
        await expect(consent).toContainText("Pay a deposit of €18.75");
        await expect(
          page.getByLabel("I accept this deposit and cancellation policy.", { exact: true }),
        ).not.toBeChecked();
        await page
          .getByLabel("I accept this deposit and cancellation policy.", { exact: true })
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `reviewed booking offer ${scheme}`);
        let writes = 0;
        await page.route("**/api/appointments", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes++;
          if (writes === 1) {
            const result = await route.fetch();
            expect(result.status(), await result.text()).toBe(201);
            visit = await result.json();
            return route.abort("connectionreset");
          }
          if (writes === 2)
            return route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "unauthorized",
                  message: "Fixture session expired after the original request",
                },
              }),
            });
          return route.continue();
        });
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const uncertain = page.getByText(
          "The booking response is uncertain. Retry the same booking to recover its result before editing or making another reservation.",
          { exact: true },
        );
        await expect(uncertain).toBeVisible();
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toBeDisabled();
        await page.getByRole("link", { name: "Services", exact: true }).click();
        const guard = page.getByRole("dialog", {
          name: "Resolve this booking request",
          exact: true,
        });
        await expect(guard).toBeVisible();
        await guard.getByRole("button", { name: "Stay and recover", exact: true }).click();
        await expect(guard).toHaveCount(0);
        attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        expect((await attempt).status()).toBe(401);
        // A later 401 cannot prove that the first request did not commit.
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toBeDisabled();
        await expect(uncertain).toBeVisible();
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promotion.id}`, {
              data: { ...terms, value: 2500, active: false, version: promotion.version + 1 },
            })
          ).status(),
        ).toBe(200);
        attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const recovered = await attempt;
        expect(recovered.status(), await recovered.text()).toBe(201);
        expect(recovered.headers()["x-idempotent-replay"]).toBe("true");
        if (!visit) throw new Error("Missing original booking");
        expect((await recovered.json()).id).toBe(visit.id);
        await expect(page).toHaveURL(new RegExp(`/book/confirmed/${visit.id}$`));
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByText("€75", { exact: true })).toBeVisible();
        const bill = await (
          await owner.get(`/api/admin/commerce/checkouts/${visit.protection.checkoutId}`)
        ).json();
        expect(bill).toMatchObject({
          totalCents: 7500,
          discountCents: 2500,
          protection: { depositCents: 1875, policyVersion },
          reward: { code, appointmentTiming: { timing: { lastMinuteHours: 168 } } },
        });
        await switchLocale(page, "Español");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `confirmed discounted deposit ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-booking-promotion-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
      } finally {
        if (visit)
          await owner.patch(`/api/appointments/${visit.id}`, {
            data: { version: visit.version, status: "cancelled" },
          });
        const current = await (await owner.get("/api/admin/settings/booking-policy")).json();
        await owner.put("/api/admin/settings/booking-policy", {
          data: { ...current, enabled: false },
        });
        if (serviceId) await owner.delete(`/api/admin/services/${serviceId}`);
        await owner.dispose();
      }
    });
  });
