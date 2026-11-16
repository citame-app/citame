import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { addDaysLocal, formatTime, localDateOf } from "../src/lib/format";
import { zonedInstant } from "../src/lib/zoned";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
} from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`processing and concurrent clients — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("books hands-on work in an exposure gap, retains frozen timings and safely changes concurrent capacity", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(180000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const customerContext = await browser.newContext({
        baseURL: fixture.baseURL,
        viewport: page.viewportSize(),
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const customer = await customerContext.newPage();
      const nextContext = await browser.newContext({
        baseURL: fixture.baseURL,
        viewport: page.viewportSize(),
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const next = await nextContext.newPage();
      const services: string[] = [];
      const bookings = new Set<string>();
      let staffId = "";
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const staff = await (await owner.get("/api/staff")).json();
        staffId = staff.staff.find(
          (r: { displayName: string }) => r.displayName === "Stylist A",
        ).id;
        const salon = await (await owner.get("/api/salon")).json();
        const timeZone = salon.timezone;
        async function create(
          name: string,
          durationMinutes: number,
          bufferMinutes: number,
          priceCents: number,
        ) {
          const r = await owner.post("/api/admin/services", {
            data: {
              name,
              durationMinutes,
              bufferMinutes,
              priceCents,
              currency: "EUR",
              staffIds: [staffId],
            },
          });
          expect(r.status(), await r.text()).toBe(201);
          const row = await r.json();
          services.push(row.id);
          return row;
        }
        const colour = await create(
          `Fixture exposure ${scheme} ${info.project.name}`,
          90,
          10,
          5000,
        );
        const express = await create(`Fixture express ${scheme} ${info.project.name}`, 30, 0, 1500);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
        await page.getByRole("link", { name: "Processing time", exact: true }).click();
        await page
          .getByLabel("Choose a treatment to configure", { exact: true })
          .selectOption(colour.id);
        await page
          .getByLabel("Release the professional during a processing interval", { exact: true })
          .check();
        await page
          .getByLabel("Active work before processing (minutes)", { exact: true })
          .fill("30");
        await page.getByLabel("Processing time (minutes)", { exact: true }).fill("60");
        await expect(
          page.getByRole("button", { name: "Save processing time", exact: true }),
        ).toBeDisabled();
        await page.getByLabel("Processing time (minutes)", { exact: true }).fill("30");
        await expect(page.getByLabel("Final active work (minutes)", { exact: true })).toHaveValue(
          "30",
        );
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `processing configuration ${scheme}`);
        let lost = false;
        await page.route(`**/api/admin/services/${colour.id}/processing`, async (route) => {
          if (lost) return route.continue();
          lost = true;
          const r = await route.fetch();
          expect(r.status(), await r.text()).toBe(200);
          await route.abort("connectionreset");
        });
        await page.getByRole("button", { name: "Save processing time", exact: true }).click();
        await expect(
          page.getByText(
            "The response is uncertain. Retry the same change or reload the saved policy before editing again.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByLabel("Processing time (minutes)", { exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "Retry the same change", exact: true }).click();
        await expect(
          page.getByText(
            "The configuration could not be saved. Your choices are preserved. Reload and review the current configuration if another person changed it.",
            { exact: true },
          ),
        ).toBeVisible();
        await page.getByRole("button", { name: "Reload saved configuration", exact: true }).click();
        const discard = page.getByRole("dialog", {
          name: "Discard configuration changes?",
          exact: true,
        });
        await discard
          .getByRole("button", { name: "Reload saved configuration", exact: true })
          .click();
        await expect(discard).toHaveCount(0);
        await expect(page.getByLabel("Processing time (minutes)", { exact: true })).toHaveValue(
          "30",
        );
        await expect(
          page.getByRole("button", { name: "Save processing time", exact: true }),
        ).toBeDisabled();
        await signInThroughUi(customer, fixture.clientEmail, `/book?services=${colour.id}`);
        await expect(
          customer.getByText("Includes 30m of processing time", { exact: true }).first(),
        ).toBeVisible();
        await customer.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(customer, "Stylist A");
        await pickFirstTime(customer);
        await customer.getByRole("button", { name: "Continue", exact: true }).click();
        let created = customer.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await customer.getByRole("button", { name: "Confirm booking", exact: true }).click();
        let response = await created;
        expect(response.status(), await response.text()).toBe(201);
        const visit = await response.json();
        bookings.add(visit.id);
        expect(visit.workWindows).toEqual([
          { offsetMinutes: 0, endOffsetMinutes: 30 },
          { offsetMinutes: 60, endOffsetMinutes: 100 },
        ]);
        const gap = new Date(Date.parse(visit.startsAt) + 30 * 60000).toISOString();
        const gapEnd = new Date(Date.parse(visit.startsAt) + 60 * 60000).toISOString();
        const date = localDateOf(visit.startsAt, timeZone);
        const email = `gap-${scheme}-${info.project.name}-${crypto.randomUUID()}@example.com`;
        expect(
          (
            await next.request.post("/api/auth/sign-up/email", {
              headers: { origin: fixture.baseURL },
              data: { email, name: "Fixture gap visitor", password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        // The fixture signup created this second customer's browser session.
        await next.goto(`/book/time?services=${express.id}&staff=${staffId}&date=${date}`);
        await next
          .getByRole("radio", { name: formatTime(gap, timeZone, "en"), exact: true })
          .check();
        await next.getByRole("button", { name: "Continue", exact: true }).click();
        created = next.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await next.getByRole("button", { name: "Confirm booking", exact: true }).click();
        response = await created;
        expect(response.status(), await response.text()).toBe(201);
        const second = await response.json();
        bookings.add(second.id);
        expect(second.startsAt).toBe(gap);
        expect(second.endsAt).toBe(gapEnd);
        await page
          .getByLabel("Release the professional during a processing interval", { exact: true })
          .uncheck();
        await page.getByRole("button", { name: "Save processing time", exact: true }).click();
        await expect(page.getByText("Configuration saved.", { exact: true })).toBeVisible();
        await page.goto(`/admin/calendar?date=${date}&view=day&staff=${staffId}`);
        const block = page.getByRole("button", {
          name: new RegExp(`Recurring fixture client.*${colour.name}`),
        });
        await expect(block).toHaveAttribute("aria-label", /Processing:/);
        await expect(block.locator("[data-processing-window]")).toHaveCount(1);
        await expectNoSeriousA11yViolations(page, `frozen calendar exposure ${scheme}`);
        await block.click();
        const drawer = page.getByRole("dialog");
        await expect(
          drawer.getByText(
            `Processing: ${formatTime(gap, timeZone, "en")}–${formatTime(gapEnd, timeZone, "en")}`,
            { exact: true },
          ),
        ).toBeVisible();
        await drawer.getByRole("button", { name: "Close panel", exact: true }).click();
        await page.goto(`/admin/staff?member=${staffId}&tab=hours`);
        await page
          .getByLabel("Concurrent clients during active work", { exact: true })
          .selectOption("2");
        await expect(
          page.getByRole("button", { name: "Save capacity", exact: true }),
        ).toBeDisabled();
        await page
          .getByLabel("I have reviewed this limit and can supervise these concurrent visits.", {
            exact: true,
          })
          .check();
        await page.getByRole("button", { name: "Save capacity", exact: true }).click();
        await expect(page.getByText("Configuration saved.", { exact: true })).toBeVisible();
        let parallelDate = addDaysLocal(date, 1);
        while ([0, 6].includes(new Date(`${parallelDate}T12:00:00Z`).getUTCDay()))
          parallelDate = addDaysLocal(parallelDate, 1);
        const parallelAt = zonedInstant(parallelDate, "10:00", timeZone);
        const parallel = await Promise.all(
          ["A", "B"].map((name) =>
            owner.post("/api/appointments", {
              data: {
                staffId,
                serviceIds: [express.id],
                startsAt: parallelAt,
                client: { name: `Fixture parallel ${name}` },
              },
            }),
          ),
        );
        const rows = [];
        for (const r of parallel) {
          expect(r.status(), await r.text()).toBe(201);
          const row = await r.json();
          rows.push(row);
          bookings.add(row.id);
        }
        await page
          .getByLabel("Concurrent clients during active work", { exact: true })
          .selectOption("1");
        await page
          .getByLabel("I have reviewed this limit and can supervise these concurrent visits.", {
            exact: true,
          })
          .check();
        await page.getByRole("button", { name: "Save capacity", exact: true }).click();
        await expect(
          page.getByText(
            "The lower limit cannot accommodate existing active work or held offers. Your selected limit is preserved; review the calendar or choose another limit.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByLabel("Concurrent clients during active work", { exact: true }),
        ).toHaveValue("1");
        expect(
          (await (await owner.get(`/api/admin/staff/${staffId}/capacity`)).json()).maxConcurrent,
        ).toBe(2);
        expect(
          (
            await owner.patch(`/api/appointments/${rows[0].id}`, {
              data: { version: rows[0].version, status: "cancelled" },
            })
          ).ok(),
        ).toBe(true);
        await page.getByRole("button", { name: "Save capacity", exact: true }).click();
        await expect(
          page.getByLabel("I have reviewed this limit and can supervise these concurrent visits.", {
            exact: true,
          }),
        ).not.toBeChecked();
        expect(
          (await (await owner.get(`/api/admin/staff/${staffId}/capacity`)).json()).maxConcurrent,
        ).toBe(1);
        await page.getByRole("radio", { name: "Español", exact: true }).check();
        await expect(
          page.getByRole("heading", { name: "Capacidad del profesional", exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Spanish capacity ${scheme}`);
        await page
          .getByRole("heading", { name: "Capacidad del profesional", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/sob-processing-capacity-${scheme}-${info.project.name}.png`,
        });
      } finally {
        const r = await owner.get("/api/appointments", {
          params: {
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 90 * 86400000).toISOString(),
            pageSize: 200,
          },
        });
        if (r.ok())
          for (const row of (await r.json()).appointments)
            if (bookings.has(row.id) && row.status === "booked")
              await owner.patch(`/api/appointments/${row.id}`, {
                data: { version: row.version, status: "cancelled" },
              });
        if (staffId) {
          const r = await owner.get(`/api/admin/staff/${staffId}/capacity`);
          if (r.ok()) {
            const cap = await r.json();
            if (cap.maxConcurrent !== 1)
              await owner.put(`/api/admin/staff/${staffId}/capacity`, {
                data: { version: cap.version, maxConcurrent: 1, confirmed: true },
              });
          }
        }
        for (const id of services) await owner.delete(`/api/admin/services/${id}`);
        await owner.dispose();
        await customerContext.close();
        await nextContext.close();
      }
    });
  });
