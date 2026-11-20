import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { addDaysLocal, localDateOf } from "../src/lib/format";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi, switchLocale } from "./helpers";
import { closeReceipt } from "./pos-helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`timed offers — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("retains uncertain editor writes, reviews changed terms and preserves the booked discount when a move is ineligible", async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const code = `TIMED_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const name = `Fixture quiet hours ${scheme} ${info.project.name}`;
      let serviceId = "";
      let visitId = "";
      let promoId = "";
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const { timezone } = await (await owner.get("/api/salon")).json();
        const staff = (await (await owner.get("/api/staff")).json()).staff.find(
          (row: { displayName: string }) => row.displayName === "Stylist A",
        );
        const serviceResponse = await owner.post("/api/admin/services", {
          data: {
            name,
            durationMinutes: 45,
            bufferMinutes: 0,
            priceCents: 10000,
            currency: "EUR",
            staffIds: [staff.id],
          },
        });
        expect(serviceResponse.status(), await serviceResponse.text()).toBe(201);
        serviceId = (await serviceResponse.json()).id;
        let date = localDateOf(new Date().toISOString(), timezone);
        let startsAt = "";
        for (let days = 0; days < 7 && !startsAt; days++, date = addDaysLocal(date, 1)) {
          const r = await owner.get("/api/availability", {
            params: { date, staffId: staff.id, serviceIds: serviceId },
          });
          expect(r.ok()).toBe(true);
          startsAt = (await r.json()).slots[0]?.startsAt ?? "";
          if (startsAt) break;
        }
        expect(startsAt).not.toBe("");
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          weekday: "long",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(startsAt));
        const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
        const weekday = part("weekday");
        const minute = Number(part("hour")) * 60 + Number(part("minute"));
        const end = Math.min(minute + 60, 1440);
        const hours = Math.max(1, Math.ceil((Date.parse(startsAt) - Date.now()) / 3600000) + 1);
        expect(hours).toBeLessThanOrEqual(168);
        const clock = (value: number) =>
          `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
        const booked = await owner.post("/api/appointments", {
          data: {
            staffId: staff.id,
            serviceIds: [serviceId],
            startsAt,
            client: { name: `Fixture timed visitor ${code}` },
          },
        });
        expect(booked.status(), await booked.text()).toBe(201);
        const visit = await booked.json();
        visitId = visit.id;
        const created = await owner.post("/api/admin/commerce/checkouts", {
          data: { appointmentId: visit.id, idempotencyKey: crypto.randomUUID() },
        });
        expect(created.status(), await created.text()).toBe(201);
        const bill = await created.json();
        await signInThroughUi(page, fixture.ownerEmail, "/admin/commerce");
        await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
        await page.getByRole("button", { name: "Loyalty & promotions", exact: true }).click();
        await page.getByRole("button", { name: "New promotion", exact: true }).click();
        await page.getByLabel("Offer name", { exact: true }).fill(name);
        await page
          .getByLabel("Code (letters, numbers, hyphen or underscore)", { exact: true })
          .fill(code);
        await page.getByLabel("Limit to appointment start times", { exact: true }).check();
        await page.getByLabel(weekday, { exact: true }).check();
        await page.getByLabel("Appointment starts from", { exact: true }).fill(clock(minute));
        if (end === 1440)
          await page
            .getByLabel("Include starts through the end of the day (24:00)", { exact: true })
            .check();
        else await page.getByLabel("Appointment starts before", { exact: true }).fill(clock(end));
        await page
          .getByLabel("Booked at most this many hours before the visit", { exact: true })
          .fill(String(hours));
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `timed editor ${scheme}`);
        let lost = false;
        await page.route("**/api/admin/rewards/promotions", async (route) => {
          if (lost || route.request().method() !== "POST") return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          promoId = (await response.json()).id;
          await route.abort("connectionreset");
        });
        await page.getByRole("button", { name: "Save promotion", exact: true }).click();
        await expect(
          page.getByText(
            "The response is uncertain. Retry the same change or reload the saved policy before editing again.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByLabel("Offer name", { exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "Retry the same change", exact: true }).click();
        await expect(page.getByText("Promotion saved", { exact: true })).toBeVisible();
        await expect(
          page.getByText(`Originally booked no more than ${hours} hours before the visit.`, {
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Transactions", exact: true }).click();
        const transactions = page.getByRole("region", { name: "Transactions", exact: true });
        await transactions.getByLabel("Search by item or receipt number").fill(name);
        await transactions.getByRole("button").filter({ hasText: name }).click();
        const receipt = page.getByRole("region", { name: "Receipt", exact: true });
        await receipt.locator("summary").filter({ hasText: "Loyalty & promotions" }).click();
        await receipt.getByLabel("Promotion code", { exact: true }).fill(code);
        await receipt.getByRole("button", { name: "Preview discount", exact: true }).click();
        await expect(receipt.getByText("Save €10 · New total €90", { exact: true })).toBeVisible();
        await expect(
          receipt.getByText(`Originally booked no more than ${hours} hours before the visit.`, {
            exact: true,
          }),
        ).toBeVisible();
        let promo = (
          await (
            await owner.get("/api/admin/rewards/promotions", { params: { search: code } })
          ).json()
        ).promotions[0];
        const { id: _id, createdAt: _created, usedCount: _used, ...editable } = promo;
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promoId}`, {
              data: { ...editable, name: `${name} updated` },
            })
          ).status(),
        ).toBe(200);
        let applying = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/admin/commerce/checkouts/${bill.id}/reward`) &&
            r.request().method() === "POST",
        );
        await receipt.getByRole("button", { name: "Apply this discount", exact: true }).click();
        expect((await applying).status()).toBe(409);
        await receipt.getByRole("button", { name: "Preview discount", exact: true }).click();
        applying = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/admin/commerce/checkouts/${bill.id}/reward`) &&
            r.request().method() === "POST",
        );
        await receipt.getByRole("button", { name: "Apply this discount", exact: true }).click();
        const applied = await applying;
        expect(applied.status(), await applied.text()).toBe(200);
        await expect(receipt.getByText(`${name} updated`, { exact: true })).toBeVisible();
        const move = await owner.patch(`/api/appointments/${visit.id}`, {
          data: {
            version: visit.version,
            startsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(),
          },
        });
        expect(move.status()).toBe(409);
        expect((await move.json()).error.code).toBe("promotion_timing_mismatch");
        promo = (
          await (
            await owner.get("/api/admin/rewards/promotions", { params: { search: code } })
          ).json()
        ).promotions[0];
        const {
          id: _nextId,
          createdAt: _nextCreated,
          usedCount: _nextUsed,
          timing: _timing,
          ...nextEditable
        } = promo;
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promoId}`, {
              data: { ...nextEditable, active: false },
            })
          ).status(),
        ).toBe(200);
        const saved = await (await owner.get(`/api/admin/commerce/checkouts/${bill.id}`)).json();
        expect(saved.totalCents).toBe(9000);
        expect(saved.reward.appointmentTiming.timing.lastMinuteHours).toBe(hours);
        await closeReceipt(page);
        await switchLocale(page, "Español");
        await page.goto(`/admin/commerce?view=transactions&checkout=${bill.id}`);
        const spanishReceipt = page.getByRole("region", { name: "Comprobante", exact: true });
        await expect(
          spanishReceipt.getByText(
            `Reserva original realizada como máximo ${hours} horas antes de la cita.`,
            { exact: true },
          ),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `saved Spanish timed receipt ${scheme}`);
        await spanishReceipt
          .getByText(`Reserva original realizada como máximo ${hours} horas antes de la cita.`, {
            exact: true,
          })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/sob-timed-promotion-receipt-${scheme}-${info.project.name}.png`,
        });
      } finally {
        if (visitId) {
          const rows = await (
            await owner.get("/api/appointments", {
              params: {
                from: new Date(Date.now() - 86400000).toISOString(),
                to: new Date(Date.now() + 8 * 86400000).toISOString(),
                pageSize: 100,
              },
            })
          ).json();
          const row = rows.appointments?.find((value: { id: string }) => value.id === visitId);
          if (row?.status === "booked")
            await owner.patch(`/api/appointments/${row.id}`, {
              data: { version: row.version, status: "cancelled" },
            });
        }
        if (serviceId) await owner.delete(`/api/admin/services/${serviceId}`);
        await owner.dispose();
      }
    });
  });
