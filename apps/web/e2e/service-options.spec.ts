import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
} from "./helpers";

for (const priceType of ["variable", "from"] as const)
  for (const scheme of ["light", "dark"] as const)
    test.describe(`${priceType} prices — ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      test("reserves reviewed pending-price terms and the team fixes the amount before collecting payment", async ({
        page,
      }, info) => {
        test.setTimeout(120000);
        const owner = await playwrightRequest.newContext({
          baseURL: fixture.baseURL,
          extraHTTPHeaders: { origin: fixture.baseURL },
        });
        const name = `Priced ${priceType} ${scheme} ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`;
        let serviceId = "",
          appointmentId = "",
          paymentId = "";
        try {
          expect(
            (
              await owner.post("/api/auth/sign-in/email", {
                data: { email: fixture.ownerEmail, password: fixture.password },
              })
            ).ok(),
          ).toBe(true);
          await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
          await page.getByRole("button", { name: "New service", exact: true }).click();
          const editor = page.getByRole("dialog", { name: "New service", exact: true });
          await editor.getByLabel("Name", { exact: true }).fill(name);
          await editor.getByLabel("Duration (minutes)", { exact: true }).fill("45");
          await editor.getByLabel("Price type", { exact: true }).selectOption(priceType);
          if (priceType === "from") await editor.getByLabel("Price", { exact: true }).fill("30");
          await editor.getByRole("checkbox", { name: "Stylist A", exact: true }).check();
          await expectNoHorizontalScroll(page);
          await expectNoSeriousA11yViolations(page, "pending-price editor");
          const created = page.waitForResponse(
            (r) => r.url().endsWith("/api/admin/services") && r.request().method() === "POST",
          );
          await editor.getByRole("button", { name: "Create", exact: true }).click();
          const service = await created;
          expect(service.status(), await service.text()).toBe(201);
          serviceId = (await service.json()).id;
          await page.request.post("/api/auth/sign-out", {
            headers: { origin: fixture.baseURL },
            data: {},
          });
          await signInThroughUi(page, fixture.clientEmail, "/book");
          await page.getByRole("searchbox", { name: "Search services" }).fill(name);
          await page.getByRole("checkbox", { name, exact: true }).check();
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await pickProfessional(page, "Stylist A");
          await pickFirstTime(page);
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
          await expect(confirm).toBeDisabled();
          await page
            .getByRole("checkbox", {
              name: "I accept that the final price is set at the salon and any advertised minimum applies.",
              exact: true,
            })
            .check();
          await expect(confirm).toBeEnabled();
          await expectNoSeriousA11yViolations(page, "pending-price customer review");
          const bookingResponse = page.waitForResponse(
            (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
          );
          await confirm.click();
          const booking = await bookingResponse;
          expect(booking.status(), await booking.text()).toBe(201);
          appointmentId = (await booking.json()).id;
          const receiptResponse = await page.request.post("/api/me/checkouts", {
            headers: { origin: fixture.baseURL },
            data: { appointmentId, idempotencyKey: crypto.randomUUID() },
          });
          expect(receiptResponse.status(), await receiptResponse.text()).toBe(201);
          const order = await receiptResponse.json();
          expect(order.status).toBe("open");
          expect(order.fulfilledAt).toBeNull();
          expect(order.lines[0].pricePending).toBe(true);
          await page.request.post("/api/auth/sign-out", {
            headers: { origin: fixture.baseURL },
            data: {},
          });
          await signInThroughUi(page, fixture.ownerEmail, "/admin/commerce");
          await page
            .getByRole("listitem")
            .filter({ has: page.getByText(name, { exact: true }) })
            .getByRole("button")
            .click();
          const receipt = page.getByRole("region", { name: "Receipt", exact: true });
          await expect(
            receipt.getByRole("button", { name: "Record payment", exact: true }),
          ).toHaveCount(0);
          if (priceType === "from") {
            await receipt.getByLabel(name, { exact: true }).fill("29.99");
            await receipt.getByRole("button", { name: "Set final prices", exact: true }).click();
            await expect(receipt.getByText("Enter a valid amount", { exact: true })).toBeVisible();
          }
          await receipt.getByLabel(name, { exact: true }).fill("75.50");
          const pricesResponse = page.waitForResponse(
            (r) =>
              r.url().endsWith(`/checkouts/${order.id}/prices`) && r.request().method() === "PUT",
          );
          await receipt.getByRole("button", { name: "Set final prices", exact: true }).click();
          const prices = await pricesResponse;
          expect(prices.status(), await prices.text()).toBe(200);
          const priced = await prices.json();
          expect(priced.totalCents).toBe(7550);
          expect(priced.lines[0].pricePending).toBe(false);
          await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
          const paidResponse = page.waitForResponse(
            (r) =>
              r.url().endsWith(`/checkouts/${order.id}/payments`) &&
              r.request().method() === "POST",
          );
          await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
          const paid = await paidResponse;
          expect(paid.status(), await paid.text()).toBe(201);
          paymentId = (await paid.json()).payment.id;
          await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
          await expectNoHorizontalScroll(page);
          await expectNoSeriousA11yViolations(page, "final-price receipt");
          await page.screenshot({
            path: `/tmp/sob-pricing-${priceType}-${scheme}-${info.project.name}.png`,
            fullPage: true,
            animations: "disabled",
          });
        } finally {
          if (paymentId)
            await owner.post(`/api/admin/commerce/payments/${paymentId}/refunds`, {
              data: {
                amountCents: 7550,
                reason: "Disposable browser fixture cleanup",
                idempotencyKey: crypto.randomUUID(),
              },
            });
          if (appointmentId)
            await owner.patch(`/api/appointments/${appointmentId}`, {
              data: { version: 1, status: "cancelled" },
            });
          if (serviceId) await owner.delete(`/api/admin/services/${serviceId}`);
          await owner.dispose();
        }
      });
    });

for (const scheme of ["light", "dark"] as const)
  test.describe(`organised catalog and complete visits — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("filters without losing choices and recovers the same multi-professional visit after a lost response and 401", async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const ids: string[] = [];
      let bookings: { id: string; version: number }[] = [];
      const suffix = `${scheme}-${info.project.name}-${crypto.randomUUID().slice(0, 6)}`;
      const hair = `Hair ${suffix}`,
        nails = `Nails ${suffix}`;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const team = (await (await owner.get("/api/staff")).json()).staff;
        for (const [i, name] of [hair, nails].entries()) {
          const result = await owner.post("/api/admin/services", {
            data: {
              name,
              durationMinutes: i ? 30 : 45,
              bufferMinutes: 0,
              priceCents: i ? 3000 : 2000,
              currency: "EUR",
              category: i ? "Nails" : "Hair",
              staffIds: [team[i].id],
              clientInstructions: i ? null : "Bring a reference photograph",
            },
          });
          expect(result.status(), await result.text()).toBe(201);
          ids.push((await result.json()).id);
        }
        await signInThroughUi(page, fixture.clientEmail, "/book");
        if ((page.viewportSize()?.width ?? 1440) < 1024) {
          const credit = page.getByText(/^Editorial illustrations generated with AI\./);
          await credit.scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await expect
            .poll(
              async () => {
                // The summary measures after hydration and can resize when fonts load.
                await page.evaluate(() =>
                  window.scrollTo(0, document.documentElement.scrollHeight),
                );
                const footer = await credit.boundingBox();
                const summary = await page
                  .getByRole("complementary", { name: "Your booking", exact: true })
                  .boundingBox();
                return !!footer && !!summary && footer.y + footer.height <= summary.y;
              },
              { message: "The fixed booking action must leave the footer credits readable" },
            )
            .toBe(true);
        }
        await page.getByLabel("Category", { exact: true }).selectOption("Hair");
        await page.getByRole("searchbox", { name: "Search services" }).fill(hair);
        await page.getByRole("checkbox", { name: hair, exact: true }).check();
        await page.getByRole("searchbox", { name: "Search services" }).fill("");
        await page.getByLabel("Category", { exact: true }).selectOption("Nails");
        await page.getByRole("checkbox", { name: nails, exact: true }).check();
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("radio", { name: /^Several professionals/ }).check();
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        const day = new Date();
        day.setDate(day.getDate() + 1);
        while ([0, 6].includes(day.getDay())) day.setDate(day.getDate() + 1);
        await page.getByLabel("Visit date", { exact: true }).fill(day.toISOString().slice(0, 10));
        await page
          .getByRole("group", { name: "Available visit times", exact: true })
          .getByRole("radio")
          .first()
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, "complete visit times");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await expect(page.getByText("Bring a reference photograph", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Confirm booking", exact: true }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Confirm booking", exact: true }).hover();
        await expectNoSeriousA11yViolations(
          page,
          "complete visit review with hovered primary action",
        );
        const note = page.getByLabel("Notes for the salon (optional)", { exact: true });
        await note.fill("Keep both treatments together");
        let attempts = 0;
        const packets: unknown[] = [];
        await page.route("**/api/appointments/visits", async (route) => {
          packets.push(route.request().postDataJSON());
          attempts++;
          if (attempts === 1) {
            const response = await route.fetch();
            expect(response.status()).toBe(201);
            bookings = (await response.json()).appointments;
            await route.abort("failed");
          } else if (attempts === 2)
            await route.fulfill({
              status: 401,
              json: { error: { code: "unauthorized", message: "Session expired" } },
            });
          else await route.continue();
        });
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        await expect(note).toBeDisabled();
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        await expect(note).toBeDisabled();
        await expect(note).toHaveValue("Keep both treatments together");
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        await expect(page).toHaveURL(/\/book\/visit-confirmed\//);
        await expect(
          page.getByRole("heading", { name: "Your visit has been reserved", exact: true }),
        ).toBeVisible();
        expect(packets).toHaveLength(3);
        expect(packets[1]).toEqual(packets[0]);
        expect(packets[2]).toEqual(packets[0]);
        await page.reload();
        await expect(page.getByRole("heading", { name: hair, exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: nails, exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, "complete visit confirmation");
        await page.screenshot({
          path: `/tmp/sob-service-visits-${suffix}.png`,
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        for (const booking of bookings)
          await owner.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        for (const id of ids) await owner.delete(`/api/admin/services/${id}`);
        await owner.dispose();
      }
    });
  });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`variants and extras — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("configures service options and a customer books the chosen variant and compatible extra at the reviewed price", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const ids: string[] = [];
      let booking: { id: string; version: number } | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
        await expect(page).toHaveURL(/\/admin\/services$/);
        const label = `Long ${crypto.randomUUID().slice(0, 8)}`;
        const name = `Haircut · ${label}`;
        const addonName = `Conditioning ${crypto.randomUUID().slice(0, 8)}`;
        await page.getByRole("button", { name: "New service", exact: true }).click();
        let form = page.getByRole("dialog", { name: "New service", exact: true });
        await form.getByLabel("Catalog type", { exact: true }).selectOption("variant");
        await form.getByLabel("Parent service", { exact: true }).selectOption(fixture.haircut);
        await form.getByLabel("Variant label", { exact: true }).fill(label);
        await expect(form.getByLabel("Name", { exact: true })).toHaveValue(name);
        await form.getByLabel("Duration (minutes)", { exact: true }).fill("60");
        await form.getByLabel("Price", { exact: true }).fill("30");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `variant editor ${scheme}`);
        let created = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/services") && r.request().method() === "POST",
        );
        await form.getByRole("button", { name: "Create", exact: true }).click();
        const variantResponse = await created;
        expect(variantResponse.status(), await variantResponse.text()).toBe(201);
        const variant = await variantResponse.json();
        ids.push(variant.id);
        await expect(form).toHaveCount(0);
        await page.getByRole("button", { name: "New service", exact: true }).click();
        form = page.getByRole("dialog", { name: "New service", exact: true });
        await form.getByLabel("Catalog type", { exact: true }).selectOption("addon");
        await form.getByLabel("Name", { exact: true }).fill(addonName);
        await form.getByLabel("Duration (minutes)", { exact: true }).fill("10");
        await form.getByLabel("Price", { exact: true }).fill("5");
        await form
          .getByRole("group", { name: "Eligible services", exact: true })
          .getByRole("checkbox", { name, exact: true })
          .check();
        await expectNoSeriousA11yViolations(page, `extra editor ${scheme}`);
        created = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/services") && r.request().method() === "POST",
        );
        await form.getByRole("button", { name: "Create", exact: true }).click();
        const extraResponse = await created;
        expect(extraResponse.status(), await extraResponse.text()).toBe(201);
        const extra = await extraResponse.json();
        ids.push(extra.id);
        await expect(form).toHaveCount(0);
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(page, fixture.clientEmail, "/book");
        await expect(page).toHaveURL(/\/book$/);
        expect(await page.getByRole("checkbox", { name: addonName, exact: true }).count()).toBe(0);
        await page.getByRole("radio", { name, exact: true }).check();
        await page.getByRole("checkbox", { name: addonName, exact: true }).check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `options selection ${scheme}`);
        await page.getByRole("radio", { name: "Español", exact: true }).check({ force: true });
        await expect(
          page.getByRole("group", { name: `Complementos de ${name}`, exact: true }),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(page, `Spanish options ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-options-es-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        await page.getByRole("radio", { name: "English", exact: true }).check({ force: true });
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(page, "Stylist A");
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await expect(page).toHaveURL(/\/book\/review/);
        await expect(
          page.getByText("€35", { exact: true }).filter({ visible: true }).first(),
        ).toBeVisible();
        const changed = await owner.patch(`/api/admin/services/${variant.id}`, {
          data: { priceCents: 3500 },
        });
        expect(changed.status(), await changed.text()).toBe(200);
        const rejected = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        expect((await rejected).status()).toBe(409);
        await expect(page).toHaveURL(/\/book\?/);
        await expect(
          page.getByText(
            "Service prices or duration changed. Review your selection and choose a time again.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByText("€40", { exact: true }).filter({ visible: true }).first(),
        ).toBeVisible();
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(page, "Stylist A");
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await expect(page).toHaveURL(/\/book\/review/);
        await expect(
          page.getByText("€40", { exact: true }).filter({ visible: true }).first(),
        ).toBeVisible();
        // Let the real API commit, then lose only the browser response. The retry must
        // recover the same visit even though the original slot is now occupied.
        let lostIntent: string | undefined;
        await page.route("**/api/appointments", async (route) => {
          if (route.request().method() !== "POST" || lostIntent) return route.continue();
          lostIntent = route.request().postDataJSON().id;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          booking = await response.json();
          await route.abort("connectionreset");
        });
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        await expect(
          page.getByText(
            "The booking response is uncertain. Retry the same booking to recover its result before editing or making another reservation.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByLabel("Notes for the salon (optional)", { exact: true }),
        ).toBeDisabled();
        await expect(page).toHaveURL(/\/book\/review/);
        const booked = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const bookedResponse = await booked;
        expect(bookedResponse.status(), await bookedResponse.text()).toBe(201);
        expect(bookedResponse.headers()["x-idempotent-replay"]).toBe("true");
        const result = await bookedResponse.json();
        expect(result.id).toBe(lostIntent);
        booking = result;
        expect(result.services.map((s: { serviceId: string }) => s.serviceId)).toEqual([
          variant.id,
          extra.id,
        ]);
        expect(result.services.map((s: { priceCents: number }) => s.priceCents)).toEqual([
          3500, 500,
        ]);
        expect(Date.parse(result.endsAt) - Date.parse(result.startsAt)).toBe(85 * 60000);
        await expect(page).toHaveURL(/\/book\/confirmed\//);
        await expectNoSeriousA11yViolations(page, `confirmed options ${scheme}`);
      } finally {
        if (booking)
          await owner.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        for (const id of ids.reverse()) await owner.delete(`/api/admin/services/${id}`);
        await owner.dispose();
      }
    });
  });
}
