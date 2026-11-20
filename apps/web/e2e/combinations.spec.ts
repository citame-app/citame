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
  test.describe(`treatment combinations — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("recovers one sequence after a lost response, preserves conflicting edits and books its ordered current services", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(120000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const account = await browser.newContext({
        baseURL: fixture.baseURL,
        viewport: page.viewportSize(),
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const customer = await account.newPage();
      let extraId = "";
      let combination:
        | {
            id: string;
            version: number;
            name: string;
            description: string | null;
            serviceIds: string[];
            active: boolean;
          }
        | undefined;
      let booking:
        | {
            id: string;
            version: number;
            startsAt: string;
            endsAt: string;
            services: { serviceId: string; priceCents: number }[];
          }
        | undefined;
      const name = `Fixture ${scheme} ${info.project.name} ${"combination".repeat(7)}`;
      const finalName = `Revised ${name}`;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const staff = await (await owner.get("/api/staff")).json();
        const professional = staff.staff.find(
          (s: { displayName: string }) => s.displayName === "Stylist A",
        );
        const serviceResponse = await owner.post("/api/admin/services", {
          data: {
            name: `Fixture finishing ${scheme} ${info.project.name}`,
            durationMinutes: 20,
            bufferMinutes: 5,
            priceCents: 1500,
            currency: "EUR",
            staffIds: [professional.id],
          },
        });
        expect(serviceResponse.status(), await serviceResponse.text()).toBe(201);
        const extra = await serviceResponse.json();
        extraId = extra.id;
        await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
        await page.getByRole("button", { name: "Combos", exact: true }).click();
        await page.getByRole("button", { name: "New combination", exact: true }).click();
        let form = page.getByRole("dialog", { name: "New combination", exact: true });
        await form.getByLabel("Combination name", { exact: true }).fill(name);
        await form.getByRole("checkbox", { name: "Haircut", exact: true }).check();
        await form.getByRole("checkbox", { name: extra.name, exact: true }).check();
        await expect(
          form
            .getByRole("region", { name: "Order of treatments and extras", exact: true })
            .getByRole("listitem"),
        ).toHaveText(["Haircut", extra.name]);
        await expectNoSeriousA11yViolations(page, `combination editor ${scheme}`);
        let lost = false;
        await page.route("**/api/admin/services/combinations", async (route) => {
          if (route.request().method() !== "POST" || lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          combination = await response.json();
          await route.abort("connectionreset");
        });
        await form.getByRole("button", { name: "Save combination", exact: true }).click();
        await expect(
          form.getByText(
            "The response is uncertain. Retry the same submission or discard and reload before changing its terms.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(form.getByLabel("Combination name", { exact: true })).toBeDisabled();
        await form.getByRole("button", { name: "Retry submission", exact: true }).click();
        await expect(form).toHaveCount(0);
        const directory = await (await owner.get("/api/admin/services/combinations")).json();
        expect(
          directory.combinations.filter((r: { name: string }) => r.name === name),
        ).toHaveLength(1);
        if (!combination) throw new Error("Missing combination");
        await expectNoHorizontalScroll(page);
        await page.getByRole("button", { name: `Edit combination: ${name}`, exact: true }).click();
        form = page.getByRole("dialog", { name: `Edit ${name}`, exact: true });
        await form
          .getByLabel("Combination name", { exact: true })
          .fill("Uncommitted operator draft");
        const external = await owner.put(`/api/admin/services/combinations/${combination.id}`, {
          data: {
            name: finalName,
            description: null,
            serviceIds: combination.serviceIds,
            active: true,
            version: combination.version,
          },
        });
        expect(external.status()).toBe(200);
        combination = await external.json();
        await form.getByRole("button", { name: "Save combination", exact: true }).click();
        await expect(
          form.getByText(
            "The combination could not be saved. Your choices are preserved. Reload the list and review the current record if it changed.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(form.getByLabel("Combination name", { exact: true })).toHaveValue(
          "Uncommitted operator draft",
        );
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
        const discard = page.getByRole("dialog", {
          name: "Discard combination changes?",
          exact: true,
        });
        await discard.getByRole("button", { name: "Discard and reload", exact: true }).click();
        await expect(form).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: `Edit combination: ${finalName}`, exact: true }),
        ).toBeVisible();
        await signInThroughUi(customer, fixture.clientEmail, "/book");
        const choice = customer.getByRole("button", {
          name: `Choose combination: ${finalName}`,
          exact: true,
        });
        await choice.click();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect(
          customer.getByRole("checkbox", { name: "Haircut", exact: true }),
        ).toBeChecked();
        await expect(
          customer.getByRole("checkbox", { name: extra.name, exact: true }),
        ).toBeChecked();
        await expectNoHorizontalScroll(customer);
        await expectNoSeriousA11yViolations(customer, `long combination choice ${scheme}`);
        await switchLocale(customer, "Español");
        await expect(
          customer.getByRole("button", { name: `Elegir combinación: ${finalName}`, exact: true }),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(customer, `Spanish combination ${scheme}`);
        await customer.screenshot({
          path: `/tmp/sob-combinations-es-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
        await switchLocale(customer, "English");
        await customer.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(customer, "Stylist A");
        await pickFirstTime(customer);
        await customer.getByRole("button", { name: "Continue", exact: true }).click();
        await expect(customer).toHaveURL(/\/book\/review/);
        const responseEvent = customer.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await customer.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const booked = await responseEvent;
        expect(booked.status(), await booked.text()).toBe(201);
        booking = await booked.json();
        if (!booking || !combination) throw new Error("Missing fixture record");
        expect(booking.services.map((s) => s.serviceId)).toEqual([fixture.haircut, extraId]);
        expect(booking.services.map((s) => s.priceCents)).toEqual([2000, 1500]);
        expect(Date.parse(booking.endsAt) - Date.parse(booking.startsAt)).toBe(85 * 60000);
        const archive = await owner.put(`/api/admin/services/combinations/${combination.id}`, {
          data: {
            name: combination.name,
            description: combination.description,
            serviceIds: combination.serviceIds,
            active: false,
            version: combination.version,
          },
        });
        expect(archive.status()).toBe(200);
        combination = await archive.json();
        await customer.goto("/book");
        await expect(
          customer.getByRole("button", { name: `Choose combination: ${finalName}`, exact: true }),
        ).toHaveCount(0);
        const visits = await (
          await customer.request.get("/api/appointments", {
            params: {
              from: new Date(Date.now() - 86400000).toISOString(),
              to: new Date(Date.now() + 45 * 86400000).toISOString(),
              pageSize: 200,
            },
          })
        ).json();
        expect(
          visits.appointments
            .find((a: { id: string }) => a.id === booking?.id)
            ?.services.map((s: { serviceId: string; priceCents: number }) => ({
              serviceId: s.serviceId,
              priceCents: s.priceCents,
            })),
        ).toEqual([
          { serviceId: fixture.haircut, priceCents: 2000 },
          { serviceId: extraId, priceCents: 1500 },
        ]);
      } finally {
        if (booking)
          await owner.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        if (combination?.active)
          await owner.put(`/api/admin/services/combinations/${combination.id}`, {
            data: {
              name: combination.name,
              description: combination.description,
              serviceIds: combination.serviceIds,
              active: false,
              version: combination.version,
            },
          });
        if (extraId) await owner.delete(`/api/admin/services/${extraId}`);
        await owner.dispose();
        await account.close();
      }
    });
  });
