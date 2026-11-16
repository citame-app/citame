import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
} from "./helpers";

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
