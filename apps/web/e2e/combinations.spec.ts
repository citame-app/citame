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
        await page.getByRole("tab", { name: "Combinations", exact: true }).click();
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

test("publishes reviewed fixed terms in the catalogue and books the displayed total", async ({
  page,
  browser,
}, info) => {
  const owner = await playwrightRequest.newContext({
    baseURL: fixture.baseURL,
    extraHTTPHeaders: { origin: fixture.baseURL },
  });
  const account = await browser.newContext({
    baseURL: fixture.baseURL,
    viewport: page.viewportSize(),
    reducedMotion: "reduce",
  });
  const customer = await account.newPage();
  const name = `Fixed terms fixture ${info.project.name}`;
  let extraId: string | undefined;
  let booking: { id: string; version: number; services: { priceCents: number }[] } | undefined;
  let walkIn: { id: string; version: number; services: { priceCents: number }[] } | undefined;
  let combo: { id: string; version: number; serviceIds: string[]; name: string } | undefined;
  try {
    expect(
      (
        await owner.post("/api/auth/sign-in/email", {
          data: { email: fixture.ownerEmail, password: fixture.password },
        })
      ).ok(),
    ).toBe(true);
    const { staff } = await (await owner.get("/api/staff")).json();
    const professional = staff.find(
      (item: { displayName: string }) => item.displayName === "Stylist A",
    );
    const extraResponse = await owner.post("/api/admin/services", {
      data: {
        name: `Fixed finish ${info.project.name}`,
        durationMinutes: 20,
        bufferMinutes: 0,
        priceCents: 1500,
        currency: "EUR",
        staffIds: [professional.id],
      },
    });
    expect(extraResponse.status()).toBe(201);
    const extra = await extraResponse.json();
    extraId = extra.id;

    await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
    await page.getByRole("tab", { name: "Combinations", exact: true }).click();
    await page.getByRole("button", { name: "New combination", exact: true }).click();
    const form = page.getByRole("dialog", { name: "New combination" });
    await form.getByLabel("Combination name").fill(name);
    await form.getByRole("checkbox", { name: "Haircut", exact: true }).check();
    await form.getByRole("checkbox", { name: extra.name, exact: true }).check();
    await form.getByRole("checkbox", { name: "Set a fixed price" }).check();
    await form.getByRole("textbox", { name: "Haircut (EUR)" }).fill("12,00");
    await form.getByRole("textbox", { name: `${extra.name} (EUR)` }).fill("8.00");
    await form.getByRole("checkbox", { name: "Stylist A", exact: true }).check();
    await form.getByLabel("Availability to customers").selectOption("public");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/services/combinations") &&
        response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "Save combination" }).click();
    const created = await saved;
    expect(created.status(), await created.text()).toBe(201);
    combo = await created.json();
    if (!combo) throw new Error("Missing saved combination");
    await expect(form).toHaveCount(0);

    await signInThroughUi(customer, fixture.clientEmail, "/book");
    const button = customer.getByRole("button", {
      name: `Choose combination: ${name}`,
      exact: true,
    });
    await button.focus();
    await button.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(customer).toHaveURL(new RegExp(`combinationId=${combo.id}`));
    await customer.getByRole("button", { name: "Continue", exact: true }).click();
    await pickProfessional(customer, "Stylist A");
    await pickFirstTime(customer);
    await customer.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(customer.getByText(/Combination total:.*20/)).toBeVisible();
    const confirmation = customer.waitForResponse(
      (response) =>
        response.url().endsWith("/api/appointments") && response.request().method() === "POST",
    );
    await customer.getByRole("button", { name: "Confirm booking", exact: true }).click();
    const response = await confirmation;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ combination: { id: combo.id } });
    booking = await response.json();
    if (!booking) throw new Error("Missing fixture appointment");
    expect(booking.services.map((line) => line.priceCents)).toEqual([1200, 800]);
    const checkout = await owner.post("/api/admin/commerce/checkouts", {
      data: { appointmentId: booking.id, idempotencyKey: crypto.randomUUID() },
    });
    expect(checkout.status(), await checkout.text()).toBe(201);
    const receipt = await checkout.json();
    expect(receipt).toMatchObject({ totalCents: 2000 });
    await page.goto(`/admin/commerce?view=sale&checkout=${receipt.id}`);
    await expect(
      page
        .getByRole("dialog", { name: "Receipt", exact: true })
        .locator("dl > div")
        .filter({
          has: page.getByText("Total", { exact: true }),
        })
        .locator("dd"),
    ).toHaveText("€20");
    await expectNoHorizontalScroll(customer);

    const hidden = await owner.put(`/api/admin/services/combinations/${combo.id}`, {
      data: {
        name: combo.name,
        serviceIds: combo.serviceIds,
        version: combo.version,
        description: null,
        active: true,
        fixedTerms: { pricesCents: [1200, 800], staffIds: [professional.id], onlineBooking: false },
      },
    });
    expect(hidden.status(), await hidden.text()).toBe(200);
    combo = await hidden.json();
    if (!combo) throw new Error("Missing internal combination");
    await customer.goto("/book");
    await expect(customer.getByRole("heading", { name: "Choose your services" })).toBeVisible();
    const published = await (
      await customer.request.get("/api/services/combinations?fixedTerms=1")
    ).json();
    expect(published.combinations.some((item: { id: string }) => item.id === combo?.id)).toBe(
      false,
    );

    const salon = await (await owner.get("/api/salon")).json();
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: salon.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    let slot: { startsAt: string } | undefined;
    let date = "";
    for (let elapsed = 1; elapsed <= 14; elapsed++) {
      date = local.format(new Date(Date.now() + elapsed * 86_400_000));
      const available = await owner.get("/api/appointments/combination-availability", {
        params: { date, combinationId: combo.id, serviceIds: combo.serviceIds.join(",") },
      });
      expect(available.status(), await available.text()).toBe(200);
      slot = (await available.json()).slots[0];
      if (slot) break;
    }
    if (!slot) throw new Error("No fixture slot for the internal combination");
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: salon.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(slot.startsAt));
    await page.goto(`/admin/calendar?date=${date}&view=day`);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.getByRole("button", { name: "New appointment", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New appointment", exact: true });
    await dialog.getByRole("radio", { name: "New client" }).check();
    await dialog.getByLabel("Full name").fill(`Fixed walk-in ${info.project.name}`);
    await dialog.getByLabel("Treatment combinations").selectOption(combo.id);
    await expect(dialog.getByLabel("Team member")).toHaveValue(professional.id);
    await dialog.getByLabel("Available times").selectOption(slot.startsAt);
    await expect(dialog.getByLabel("Start time")).toHaveValue(time);
    await expect(dialog.getByText(/Combination total:.*20/)).toBeVisible();
    const bookedByTeam = page.waitForResponse(
      (result) =>
        result.url().endsWith("/api/appointments") && result.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create appointment" }).click();
    const walkInResponse = await bookedByTeam;
    expect(walkInResponse.status(), await walkInResponse.text()).toBe(201);
    expect(walkInResponse.request().postDataJSON()).toMatchObject({
      combination: { id: combo.id },
    });
    walkIn = await walkInResponse.json();
    expect(walkIn?.services.map((item) => item.priceCents)).toEqual([1200, 800]);
    await expectNoHorizontalScroll(page);
  } finally {
    if (combo) {
      await owner.put(`/api/admin/services/combinations/${combo.id}`, {
        data: {
          name: combo.name,
          serviceIds: combo.serviceIds,
          version: combo.version,
          description: null,
          active: false,
        },
      });
    }
    if (booking)
      await owner.patch(`/api/appointments/${booking.id}`, {
        data: { version: booking.version, status: "cancelled" },
      });
    if (walkIn)
      await owner.patch(`/api/appointments/${walkIn.id}`, {
        data: { version: walkIn.version, status: "cancelled" },
      });
    if (extraId) await owner.delete(`/api/admin/services/${extraId}`);
    await owner.dispose();
    await account.close();
  }
});
